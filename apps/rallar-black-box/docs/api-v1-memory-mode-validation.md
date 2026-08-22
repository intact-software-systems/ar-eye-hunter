# API-v1 Memory-Mode Validation

This document describes how `apps/rallar-black-box` validates API-v1 when the
server runs with PGlite memory persistence.

## Commands

Full-stack smoke against API-v1 memory mode:

```sh
npm run test:rallar:full-stack:memory
```

Three-browser RTC baseline against API-v1 memory mode:

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
```

Both scripts set:

```text
RALLAR_BLACK_BOX_FULL_STACK=1
RALLAR_BLACK_BOX_API_MODE=memory
```

When `VITE_RALLAR_API_BASE_URL` is omitted, the full-stack config defaults to
`http://localhost:8080`.

The three-browser RTC script also sets:

```text
RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1
VITE_RALLAR_API_BASE_URL=http://localhost:18080
VITE_RALLAR_SPA_BASE_URL=http://localhost:5177
VITE_RALLAR_APPLICATION_ID=rallar-server
VITE_RALLAR_ROOM_ID=rallar-bb-memory-live-rtc
VITE_RALLAR_AGENT_A_USERNAME=alice
VITE_RALLAR_AGENT_A_PASSWORD=secret
VITE_RALLAR_AGENT_B_USERNAME=bob
VITE_RALLAR_AGENT_B_PASSWORD=secret
VITE_RALLAR_AGENT_C_USERNAME=charlie
VITE_RALLAR_AGENT_C_PASSWORD=secret
```

The Playwright full-stack config then starts API-v1 with:

```text
RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory
RALLAR_API_BASE_URL=http://localhost:18080
RALLAR_WS_BASE_URL=ws://localhost:18080
RALLAR_LOGIN_USER_RATE_LIMIT=100
```

The selected profile owns PGlite memory, automatic schema initialization,
local pub/sub, local ICE, demo clients, and strict state reads. The harness
also injects bounded auth and operator-token fixture secrets; it does not load
them from ambient env files.

`RALLAR_API_BASE_URL` and `RALLAR_WS_BASE_URL` are derived from
`VITE_RALLAR_API_BASE_URL`, and API CORS is derived from
`VITE_RALLAR_SPA_BASE_URL`, so `/api/config` and the browser harness use the
same isolated local ports.

The existing Postgres-backed scripts still use `RALLAR_BLACK_BOX_API_MODE`
defaulting to `postgres`.

## Acceptance Coverage

The memory smoke script runs:

- `full-stack-command-center-qa-matrix.spec.ts`
- `full-stack-rest-workbench.spec.ts`
- `full-stack-quick-test-ws.spec.ts`

These cover API readiness, auth negative behavior, authenticated login, WS
ticket creation, protected REST without a token, group creation/join/readback,
authenticated REST collections, WebSocket subscription, and real WS group
message delivery.

The memory RTC script runs:

- `full-stack-live-rtc-three-browser-matrix.spec.ts`

That spec launches three isolated browser contexts per transport phase,
authenticates three agents, creates and joins a unique group, opens
authenticated API WebSockets, sends live WS data, exercises realtime and
`messages.rtc` direct/multicast/broadcast delivery, checks negative/stale-send
paths, and exports control artifacts. Realtime and `messages.rtc` use fresh
browser trios against the same API-v1 group so the validation covers both
transport families without depending on same-page close/reconnect behavior.

Verified on 2026-06-01 with:

```sh
npm run test:rallar:full-stack:memory -- --project chromium

npm run test:rallar:full-stack:memory:live-rtc-3 -- --project chromium
```

The smoke command passed 7 memory-mode full-stack tests. The RTC command passed
the gated three-browser baseline and skipped the exhaustive matrix unless
`RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1` is set.

## Postgres Versus Memory Notes

| Area                       | Postgres Full Stack                      | PGlite Memory Full Stack                                           |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| SQL backend                | `postgres.js` with `DATABASE_URL`        | PGlite via the API-v1 `PSqlSql` adapter                            |
| Runtime API config         | `prod-in-memory` plus Postgres overrides | `prod-in-memory` plus URL/workload overrides                       |
| ICE config                 | Local unless explicitly overridden       | Local no-cost ICE config                                           |
| Auth rate limiting         | Default API-v1 limits                    | Relaxed user login limit for repeated smoke logins                 |
| Schema                     | Prisma migrations / existing DB          | Idempotent `in-memory-schema.sql` bootstrap                        |
| Queue pub/sub              | Postgres `LISTEN/NOTIFY`                 | Local in-process queue pub/sub bridge                              |
| Data lifetime              | Durable until DB cleanup                 | Ephemeral per API-v1 process                                       |
| Multi-process fidelity     | Suitable for production-like behavior    | Single API process only                                            |
| Performance interpretation | Useful for DB-inclusive behavior         | Useful for middleware/browser load shape, not production DB tuning |

Expected artifacts are the normal Playwright traces/screenshots on failure and,
for the RTC baseline, the control-server artifact export verified by the live
three-browser matrix. Compare Postgres and memory runs by looking at:

- API-v1 startup logs for SQL backend, schema init, and pub/sub mode
- pass/fail parity of the same full-stack specs
- command-center and control-server result payloads
- delivery latency and timing logs as relative indicators only
- absence of external Postgres startup or migration requirements in memory mode

## Useful Overrides

To use another API port:

```sh
VITE_RALLAR_API_BASE_URL=http://localhost:18080 \
VITE_RALLAR_SPA_BASE_URL=http://localhost:5177 \
npm run test:rallar:full-stack:memory
```

The Playwright config derives the API server `PORT` from
`VITE_RALLAR_API_BASE_URL`.

For the exhaustive RTC scenario matrix:

```sh
RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 \
npm run test:rallar:full-stack:memory:live-rtc-3
```
