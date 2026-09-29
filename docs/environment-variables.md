# Environment Variables

This document inventories environment variables used by the apps in this
repository, plus the repository-level test and infrastructure variables that
drive those apps.

Last reviewed: 2026-08-28.

## Conventions

- Deno server apps read environment variables at runtime through `Deno.env`.
- Vite browser apps read variables through `import.meta.env`. Those values are
  embedded into the browser bundle and are public. Do not put production secrets
  in `VITE_*`, `API_*`, or any prefix exposed by a Vite app.
- API-v1 operational booleans accept only `1`, `true`, `0`, or `false`. Other
  processes own their own exact decoders.
- Comma-separated variables are trimmed. API-v1 rejects empty and duplicate
  entries at startup (a trailing comma fails); the black-box control server and
  headless worker ignore empty entries.
- Values from local `.env` files are intentionally not recorded here. Only
  variable names and behavior are documented.
- API-v1 and Relic select production behavior with
  `RALLAR_API_CONFIGURATION_PROFILE=prod`; use `prod-hardened` when public registration and bundled
  users must be disabled. The black-box control process uses
  its separate explicit `RALLAR_PRODUCTION_HARDENING=1` switch. See
  [Production Env Hardening Checklist](./production-env-hardening-checklist.md).

## Environment Files Found

None of these files is tracked; all are ignored by `.gitignore` (`**.env**`) and exist only as optional local
files. The variable lists below describe the expected contents, not a committed template. API-v1 profiles with
local ICE (`dev`, `prod-in-memory`) reject `METERED_APP_NAME` and `METERED_API_KEY`, so keep those out of env
files that local runs load, or set `RALLAR_ICE_MODE=metered` for that run.

| File                                     | Variables present                                                                                                                         | Notes                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env`                                   | `VITE_RALLAR_PROVIDER`, `VITE_RALLAR_API_BASE_URL`, `VITE_RALLAR_ROOM_ID`, `VITE_RALLAR_USERNAME`, `VITE_RALLAR_PASSWORD`, `CORS_ORIGINS` | Read from repo root by some Vite and root scripts. `apps/rallar-black-box` now exposes only `VITE_*` values to the browser bundle. API-v1 may receive this file through root npm scripts.                                           |
| `apps/api-v1/.env`                       | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`, `CORS_ORIGINS`                                                                     | Loaded by API-v1 when run from `apps/api-v1`; also passed by root black-box API scripts and loaded by Relic server startup.                                                                                                         |
| `apps/api-v1/.env.local`                 | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`, `CORS_ORIGINS`                                                                     | Local override file used by root black-box API scripts and by Relic server startup.                                                                                                                                                 |
| `apps/rallar-black-box/.env.local`       | `VITE_RALLAR_PROVIDER`, `VITE_RALLAR_API_BASE_URL`, `VITE_RALLAR_ROOM_ID`, `VITE_RALLAR_USERNAME`, `VITE_RALLAR_PASSWORD`, `CORS_ORIGINS` | Present, but current `apps/rallar-black-box/vite.config.ts` uses repo-root `envDir`, so this file is not loaded by Vite unless the config changes or variables are exported by the shell. Only `VITE_*` values are browser-exposed. |
| `apps/relic-hunter-server-v1/.env.local` | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`                                                                                     | Loaded explicitly by `apps/relic-hunter-server-v1/src/main.ts`.                                                                                                                                                                     |
| `apps/relic-hunters-v1/.env`             | `API_BASE_URL`                                                                                                                            | Loaded by Vite for the Relic Hunters browser app.                                                                                                                                                                                   |
| `apps/relic-hunters-v1/.env.local`       | `API_BASE_URL`                                                                                                                            | Local Vite override for the Relic Hunters browser app.                                                                                                                                                                              |

## apps/api-v1

API-v1 is a Deno/Hono server. `src/main.ts` imports
`jsr:@std/dotenv/load`, so `.env` in the current working directory is loaded
when the app starts. Root scripts additionally pass
`--env-file=apps/api-v1/.env.local --env-file=apps/api-v1/.env --env-file=.env`
for some Rallar Black Box runs.

API-v1 reads its environment once at startup, applies it to one committed
profile, validates the complete result, and passes a deeply frozen snapshot to
the runtime. Configuration is restart-only. The precedence is:

```text
defaults-config.json
  -> selected profile JSON
  -> explicit environment overrides
  -> environment-only secrets
  -> exact decoding and invariant validation
  -> immutable runtime snapshot
```

`RALLAR_API_CONFIGURATION_PROFILE` accepts only the case-sensitive values
`dev`, `prod`, `prod-hardened`, and `prod-in-memory`. Absence selects `dev`;
`prod` uses production infrastructure with public registration and bundled ordinary users, while
`prod-hardened` always enables hardening. API-v1 hardening is owned only by the selected profile.

The exact non-secret override allowlist is:

- HTTP/public API: `PORT`, `CORS_ORIGINS`, `RALLAR_API_BASE_URL`,
  `RALLAR_WS_BASE_URL`.
- Database: `RALLAR_SQL_BACKEND`, `RALLAR_PGLITE_DATA_DIR`,
  `RALLAR_PGLITE_SCHEMA_INIT`, `RALLAR_DB_PUBSUB`,
  `RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR`.
- Authentication/state: `AUTH_REGISTRATION_MODE`, `AUTH_ADMIN_CLIENT_IDS`,
  `AUTH_STATIC_CLIENTS_MODE`, `RALLAR_LOGIN_IP_RATE_LIMIT`,
  `RALLAR_LOGIN_USER_RATE_LIMIT`, `RALLAR_REGISTRATION_IP_RATE_LIMIT`,
  `RALLAR_REGISTRATION_USER_RATE_LIMIT`, `RALLAR_STATE_STRICT_READ_AUTH`.
- Group: `RALLAR_GROUP_DEFAULT_MAX_MEMBERS`,
  `RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT`,
  `RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT`,
  `RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT`,
  `RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT`.
- Topology: `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT`,
  `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`,
  `RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE`, `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE`,
  `RALLAR_RTC_TOPOLOGY_MESH_PARAM_K`,
  `RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH`,
  `RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH`,
  `RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS`,
  `RALLAR_RTC_TOPOLOGY_REPLAY`, `RALLAR_API_QUEUE_WORKERS`.
- AppInbox/observability: `RALLAR_APP_INBOX_PHASE_TIMING`,
  `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`,
  `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`, `RALLAR_TIMING_LOGS`.
- ICE/CRDT/black-box: `RALLAR_ICE_MODE`, `METERED_APP_NAME`,
  `METERED_REGION`, `RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON`,
  `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`,
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`.

Only `DATABASE_URL`, `RALLAR_AUTH_CREDENTIAL_SECRET`, `METERED_API_KEY`, and
`RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` are secret inputs. They must remain in
the process secret store and never in committed profile JSON. Startup summaries
and errors report names and safe resolved modes, never secret values.

`ENVIRONMENT`, the unprefixed server `API_BASE_URL`, formation damping
variables, dissemination mode variables, and old web-config resources are not
read; API-v1 ignores them silently. There are no aliases or transitional
readers. The Deno Deploy preflight rejects `ENVIRONMENT` and
`RALLAR_PRODUCTION_HARDENING` in the production context.

### Server

| Variable                           | Required | Default          | Usage                                                                                                                                                                        |
| ---------------------------------- | -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_API_CONFIGURATION_PROFILE` | No       | `dev`            | Selects one exact committed profile.                                                                                                                                         |
| `PORT`                             | No       | Profile/defaults | HTTP listen port from `1` through `65535`.                                                                                                                                   |
| `CORS_ORIGINS`                     | No       | Profile/defaults | Exact comma-separated browser origins. Hardened production requires exact HTTPS origins.                                                                                     |
| `RALLAR_API_BASE_URL`              | No       | Profile/defaults | Canonical public HTTP API URL.                                                                                                                                               |
| `RALLAR_WS_BASE_URL`               | No       | Profile/defaults | Canonical public WebSocket URL.                                                                                                                                              |
| `RALLAR_STATE_STRICT_READ_AUTH`    | No       | Profile/defaults | Applies full-state read authorization to client/group list, snapshot, and event reads. SPA statistics retain independent route-local authentication and group-policy checks. |

### Database

| Variable                    | Required                                                                                                           | Default                                                                                | Usage                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_SQL_BACKEND`        | No                                                                                                                 | Profile-owned                                                                          | Selects SQL backend. Supported values: `postgres`, `pglite-memory`, `pglite-file`.                                                                                                                       |
| `DATABASE_URL`              | Required when the resolved database mode is `postgres` (`prod`, `prod-hardened`, or `RALLAR_SQL_BACKEND=postgres`) | None                                                                                   | Absolute `postgres:` or `postgresql:` URL used by runtime repositories and Prisma. Ignored by PGlite modes. If the URL contains `schema=...`, API-v1 converts it to `search_path=...` for `postgres.js`. |
| `RALLAR_PGLITE_DATA_DIR`    | Required for `RALLAR_SQL_BACKEND=pglite-file`                                                                      | Profile-owned: `memory://`                                                             | PGlite storage location. `pglite-file` requires a filesystem path and rejects `memory://`; `pglite-memory` accepts only `memory://`; `postgres` rejects any explicit value.                              |
| `RALLAR_PGLITE_SCHEMA_INIT` | Must be `disabled` with `postgres`                                                                                 | Profile-owned: `auto` (`dev`, `prod-in-memory`); `disabled` (`prod`, `prod-hardened`)  | PGlite schema bootstrap mode. Supported values: `auto`, `disabled`. It does not follow `RALLAR_SQL_BACKEND`: switching a PGlite profile to `postgres` also needs `RALLAR_PGLITE_SCHEMA_INIT=disabled`.   |
| `RALLAR_DB_PUBSUB`          | Must match the backend                                                                                             | Profile-owned: `local` (`dev`, `prod-in-memory`); `postgres` (`prod`, `prod-hardened`) | Queue pub/sub mode. Supported values: `postgres`, `local`, `disabled`. `postgres` permits only `postgres`/`disabled`; PGlite permits only `local`/`disabled`. It does not follow `RALLAR_SQL_BACKEND`.   |

### Auth And Rate Limits

| Variable                              | Required                     | Default                                                                                         | Usage                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_REGISTRATION_MODE`              | No                           | Profile-owned                                                                                   | Exact values are `public` or `admin`. `admin` requires an authenticated admin client for `/api/auth/register`; any other value rejects startup.                                                                                                                                                                                                                               |
| `AUTH_ADMIN_CLIENT_IDS`               | Required for `prod-hardened` | Profile-owned: `admin` (`dev`, `prod-hardened`); empty (`prod`); `admin,bob` (`prod-in-memory`) | Comma-separated platform-admin allow-list for admin-only registration, topology management, CRDT admin routes, admin operations, and admin support explain routes. `prod-hardened` rejects an empty list and any `admin` entry (case-insensitive), so it cannot start on the inherited default. `prod` rejects bundled demo client IDs. Entries must be non-empty and unique. |
| `AUTH_STATIC_CLIENTS_MODE`            | No                           | Profile-owned: `demo`; `disabled` in `prod-hardened`                                            | `demo` enables the bundled local clients from `resources/authorised-clients.json` (`admin`, `user`, `guest`, `test`, `test2`, `alice`, `bob`, `charlie`). `disabled` removes static clients from login and registration conflict checks and is required by `prod-hardened`.                                                                                                   |
| `RALLAR_AUTH_CREDENTIAL_SECRET`       | Yes                          | None                                                                                            | Stable server-only HMAC secret for deterministically reconstructing AppInbox-issued access tokens and one-time tickets without persisting their plaintext. Must contain at least 32 characters and remain unchanged for the lifetime of outstanding sessions, tickets, and durable results.                                                                                   |
| `RALLAR_LOGIN_IP_RATE_LIMIT`          | No                           | `30`                                                                                            | Login attempts per client IP per 60 seconds. Must be a positive integer.                                                                                                                                                                                                                                                                                                      |
| `RALLAR_LOGIN_USER_RATE_LIMIT`        | No                           | `5`                                                                                             | Login attempts per client IP plus username per 60 seconds. Must be a positive integer. The full-stack Playwright API server, the Postgres live-RTC and exhaustive scripts, and the Hetzner controller raise this to `100`.                                                                                                                                                    |
| `RALLAR_REGISTRATION_IP_RATE_LIMIT`   | No                           | `20`                                                                                            | Registration attempts per client IP per 60 seconds. Must be a positive integer.                                                                                                                                                                                                                                                                                               |
| `RALLAR_REGISTRATION_USER_RATE_LIMIT` | No                           | `5`                                                                                             | Registration attempts per client IP plus username per 60 seconds. Must be a positive integer.                                                                                                                                                                                                                                                                                 |

### Realtime Topology And Group Formation

| Variable                                             | Required | Default   | Usage                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_GROUP_DEFAULT_MAX_MEMBERS`                   | No       | `256`     | Default group member cap applied when a group stores `maxMembers: null`. Positive integer; `0` disables the default so null-cap groups stay uncapped. A stored `maxMembers` always wins over the default. Over-cap admission answers the existing `group-full` 403. |
| `RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT`   | No       | `60`      | Join-admission requests (join, invite-accept, upsert-self member) per principal per group per 60 seconds. Positive integer. Over-limit answers `429` with `Retry-After: 60`.                                                                                        |
| `RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT`       | No       | `600`     | Join-admission requests (join, invite-accept, upsert-self member) per group per 60 seconds across all principals. Positive integer. Over-limit answers `429` with `Retry-After: 60`.                                                                                |
| `RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT` | No       | `120`     | Group presence connect requests per principal per group per 60 seconds. Positive integer. Over-limit answers `429` with `Retry-After: 60`.                                                                                                                          |
| `RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT`     | No       | `1200`    | Group presence connect requests per group per 60 seconds across all principals. Positive integer. Over-limit answers `429` with `Retry-After: 60`.                                                                                                                  |
| `RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`          | No       | `500`     | Debounce for coalesced group-revision topology recomputes. Non-negative integer; `0` makes coalesced work due immediately.                                                                                                                                          |
| `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS` | No       | `30000`   | Per-group interval floor between RTT-driven placement refinements: an accepted RTT report only enqueues a refinement replan when this interval has elapsed since the group's last one. Non-negative integer; `0` removes the floor.                                 |
| `RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS`           | No       | `5`       | Vivaldi-delta threshold for RTT-driven refinement: predicted-RTT movement accumulates per group and a refinement replan is enqueued only once the accumulated movement reaches this many milliseconds. Non-negative integer; `0` refines per accepted report.       |
| `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT`                   | No       | `5`       | Maximum per-session degree used by topology planning. Positive integer.                                                                                                                                                                                             |
| `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`              | No       | `5`       | Maximum peers per session for RTT reporting admission. Positive integer. The server uses the larger of this value and the group's topology `degreeLimit`, so it never rejects evidence for a planned edge.                                                          |
| `RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE`                  | No       | `5`       | Smallest active-session count planned as a tree instead of a star. Positive integer.                                                                                                                                                                                |
| `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE`                  | No       | `16`      | Smallest active-session count planned as a mesh instead of a tree. Positive integer.                                                                                                                                                                                |
| `RALLAR_RTC_TOPOLOGY_MESH_PARAM_K`                   | No       | `2`       | Mesh construction K parameter. Positive integer.                                                                                                                                                                                                                    |
| `RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH`                | No       | `4`       | Kind-hysteresis band width below the effective `meshMinSize`: a mesh group only downgrades to tree once its active size falls below `max(treeMinSize, meshMinSize − width)` (default 16 − 4 = 12). Non-negative integer; `0` disables the band.                     |
| `RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH`                | No       | `0`       | Kind-hysteresis band width below the effective `treeMinSize`: a tree group only downgrades to star once its active size falls below `max(2, treeMinSize − width)`. Non-negative integer; `0` (the default) keeps the pre-hysteresis boundary.                       |
| `RALLAR_RTC_TOPOLOGY_REPLAY`                         | No       | `enabled` | Durable topology replay lane. Supported values: `enabled`, `disabled`.                                                                                                                                                                                              |
| `RALLAR_API_QUEUE_WORKERS`                           | No       | `enabled` | Queue workers on this process. `disabled` requires `RALLAR_SQL_BACKEND=postgres`.                                                                                                                                                                                   |

Startup also rejects `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE` below the tree minimum,
`RALLAR_RTC_TOPOLOGY_MESH_PARAM_K` above the degree limit, and
`RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS` above the maximum retry interval.
`RALLAR_APP_INBOX_WAIT_JITTER_RATIO` must be a number from `0` through `1`.

### Black Box Operator Tokens

| Variable                                 | Required                                                              | Default                                                 | Usage                                                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` | Required at startup for `prod`, `prod-hardened`, and `prod-in-memory` | None                                                    | HMAC secret used by API-v1 to issue short-lived control-server operator tokens. The same value must be configured on the black-box control server. The `dev` profile disables the broker (`/api/black-box/control-token` answers `503`) and ignores this secret. |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS` | No                                                                    | `86400000`                                              | TTL for logged-in operator tokens. Positive integer. Prefer short TTLs and bearer headers.                                                                                                                                                                       |
| `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`   | Required for `prod` and `prod-hardened`                               | Profile-owned: empty; `prod-in-memory` uses `admin,bob` | Comma-separated allow-list of authenticated client IDs that may request `/api/black-box/control-token`. `prod` and `prod-hardened` reject an empty list, and `prod` also rejects bundled demo client IDs.                                                        |
| `RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR`   | No                                                                    | Disabled                                                | Enables PGlite evidence publication into this directory for black-box state-write evidence. Requires a PGlite database mode; rejected with `postgres`. Set by the api-v1 black-box runner.                                                                       |

### ICE / WebRTC

| Variable                                  | Required                                                                          | Default                                       | Usage                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_ICE_MODE`                         | No                                                                                | Profile-owned                                 | ICE provider. Supported values: `metered`, `local`. `local` returns an empty ICE server list and avoids Metered API calls.                                                                                                                                                                                                       |
| `METERED_APP_NAME`                        | Required at startup when ICE mode resolves to `metered` (`prod`, `prod-hardened`) | None                                          | Metered TURN app name. Used in `https://<app>.metered.live/...`. Rejected at startup when ICE mode is `local` (`dev`, `prod-in-memory`).                                                                                                                                                                                         |
| `METERED_API_KEY`                         | Required at startup when ICE mode resolves to `metered` (`prod`, `prod-hardened`) | None                                          | Metered TURN API key. Server-only secret. Rejected at startup when ICE mode is `local` (`dev`, `prod-in-memory`), so do not leave it in env files loaded by local profiles.                                                                                                                                                      |
| `METERED_REGION`                          | No                                                                                | `eu`                                          | Optional override for the mandatory Metered TURN region. Ignored when ICE mode is `local`.                                                                                                                                                                                                                                       |
| `RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON` | No                                                                                | `[{"documentType":"*","rollout":"disabled"}]` | JSON array (non-empty) of CRDT document-type policies with `documentType`, `rollout` (`disabled`, `experimental-local`, `experimental-live`, `durable-beta`, `production`), and optional `applicationId`, `workspaceId`, `scope` (`room`, `principal`, `app`, `custom`, `any`). Duplicate scopes or invalid JSON reject startup. |

### Timing And App Inbox Tuning

| Variable                                      | Required | Default | Usage                                                                                                                            |
| --------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_TIMING_LOGS`                          | No       | Enabled | Enables the console timing sink. Exact values `0` and `false` disable it; `1` and `true` enable it. Other values reject startup. |
| `RALLAR_APP_INBOX_PHASE_TIMING`               | No       | `false` | Enables phase timing in app inbox processing.                                                                                    |
| `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`        | No       | `30000` | Max app inbox wait time. Invalid values reject startup.                                                                          |
| `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`     | No       | `250`   | Initial app inbox retry interval. Invalid values reject startup.                                                                 |
| `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS` | No       | `1000`  | Max app inbox retry interval. Invalid values reject startup.                                                                     |
| `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`          | No       | `0.1`   | App inbox retry jitter ratio. Invalid values reject startup.                                                                     |

### Scripts

| Script                                                  | Variables set by script                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd apps/api-v1 && deno task start:memory`              | `RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory`.                                                                                                                                                            |
| `npm run dev:rallar:api` and `npm run start:rallar:api` | Local CORS origins plus app and root env files; selector absence chooses `dev`.                                                                                                                               |
| `npm run start:rallar:api:memory`                       | `prod-in-memory` plus the Rallar Black Box local CORS origins. Loads no env files, so `RALLAR_AUTH_CREDENTIAL_SECRET` (≥32 characters) and `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` must come from the shell. |

## apps/ar-eye-hunter-v1

This is a Vite browser app. `vite.config.ts` exposes `VITE_*` and `API_*`
variables to the client bundle.

| Variable                         | Required | Default                             | Usage                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                   | Yes      | None                                | Read from `import.meta.env` at startup. Configures the shared browser Rallar API client. The app throws `Missing API_BASE_URL` if it is absent.                                                                                                                                        |
| `VITE_RALLAR_AUTH_STORAGE`       | No       | `session`                           | Browser auth-session storage: `session` or `local`. Other values leave the shared library default (`local`).                                                                                                                                                                           |
| `VITE_RALLAR_BROWSER_AI`         | No       | `mock`                              | Browser RallarAI mode for app-local chaos director and avatar cosmetics. `webllm` attempts real in-browser WebLLM (unavailable without WebGPU), `mock` uses the deterministic browser provider, and `off`, `disabled`, `0`, `false`, or `no` disable it. Unknown values select `mock`. |
| `VITE_RALLAR_BROWSER_AI_ENABLED` | No       | Enabled                             | Optional boolean override. `false`, `0`, `no`, or `off` disables browser RallarAI even if `VITE_RALLAR_BROWSER_AI=webllm`.                                                                                                                                                             |
| `VITE_RALLAR_WEBLLM_MODEL`       | No       | `Llama-3.2-1B-Instruct-q4f16_1-MLC` | WebLLM model ID used when `VITE_RALLAR_BROWSER_AI=webllm`. Choose a small prebuilt WebLLM model for iPad/phone safety.                                                                                                                                                                 |

| Variable                  | Required | Default  | Usage                                                                                                                                        |
| ------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_ARENA_FULL_STACK` | No       | Disabled | `1` enables `tests/playwright/ar-eye-hunter/director-capability-delivery.spec.ts`, which needs the local API-v1 memory fixture on port 8080. |

The app defaults browser RallarAI to enabled with the deterministic in-browser
provider. The GitHub Cloudflare Pages build (`.github/workflows/deploy.yml`) exports
`VITE_RALLAR_AUTH_STORAGE=session`, `VITE_RALLAR_BROWSER_AI=webllm`,
`VITE_RALLAR_BROWSER_AI_ENABLED=true`, and
`VITE_RALLAR_WEBLLM_MODEL=Llama-3.2-1B-Instruct-q4f16_1-MLC`, so production uses
real browser WebLLM. There is no automatic fallback: without WebGPU the AI
director reports `unavailable` and avatar cosmetics keep the deterministic
profile. These are public Vite values; do not put provider secrets in `VITE_*`
variables.

## apps/relic-hunters-v1

This is a Vite browser app. `vite.config.ts` exposes `VITE_*` and `API_*`
variables to the client bundle.

### Runtime

| Variable       | Required | Default      | Usage                                                                                                                                                                                                                                                                                              |
| -------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL` | No       | Empty string | Configures the shared browser Rallar API client. Empty string means same-origin API calls, which works with the Vite dev `/api` proxy. In dev, a localhost URL pointing at a different port is normalized to empty string so the proxy is used. In production, a non-empty value is used directly. |

### Playwright / Test Controls

| Variable                     | Required | Default  | Usage                                                                                                                                                  |
| ---------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RELIC_HUNTERS_FULL_STACK`   | No       | Disabled | `1` or `true` enables paired Relic server startup in `apps/relic-hunters-v1/playwright.full-stack.config.ts` and enables full-stack propagation tests. |
| `RELIC_SCENE_BASELINE_WRITE` | No       | Disabled | `1` or `true` makes `tests/playwright/relic-hunters/web.spec.ts` write scene baseline screenshots and metrics.                                         |

When `RELIC_HUNTERS_FULL_STACK` is enabled, the Playwright config starts:

- `apps/relic-hunter-server-v1` with `CORS_ORIGINS=http://localhost:5175,http://127.0.0.1:5175` and `PORT=8090`.
- `apps/relic-hunters-v1` with `API_BASE_URL=http://127.0.0.1:8090`.

## apps/relic-hunter-server-v1

This is a Deno/Hono server for the Relic Hunters game. It explicitly attempts
to load:

1. `apps/relic-hunter-server-v1/.env`
2. `apps/relic-hunter-server-v1/.env.local`
3. `apps/api-v1/.env`
4. `apps/api-v1/.env.local`

The server imports API-v1 Rallar server wiring, so API-v1 database, auth, ICE,
and timing variables also apply to this app when those shared routes and
repositories are used.

### Relic Server Variables

| Variable                              | Required | Default                                                                  | Usage                                                                                                                                                                          |
| ------------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                | No       | API-v1 profile/defaults (`8080`)                                         | HTTP listen port, decoded by the embedded API-v1 configuration (`1` through `65535`). The Relic Vite dev proxy targets `8090`, so set `PORT=8090` for local Relic development. |
| `CORS_ORIGINS`                        | No       | API-v1 profile/defaults (`dev`: `http://localhost:5173` through `:5176`) | Exact comma-separated browser origins for `/api/*`, decoded by the embedded API-v1 configuration. `*` reflects any request origin.                                             |
| `RALLAR_API_CONFIGURATION_PROFILE`    | No       | `dev`                                                                    | Selects the same immutable API-v1 profile used by the embedded server. Production uses `prod` by default or `prod-hardened` for forced hardening.                              |
| `RELIC_REST_AUTH_MODE`                | No       | Profile-owned                                                            | Local profiles default to `authenticated` and may override the mode. Production profiles own `group-policy` and reject this variable.                                          |
| `RELIC_AI_EXPEDITION_MODE`            | No       | `off`                                                                    | Optional server-side expedition setup generation. Supported values: `off`, `mock`, and `ollama`.                                                                               |
| `RELIC_AI_EXPEDITION_TIMEOUT_MS`      | No       | `15000`                                                                  | Timeout for server-side expedition blueprint generation before procedural fallback. Must be a positive integer.                                                                |
| `RELIC_AI_EXPEDITION_OLLAMA_BASE_URL` | No       | `http://127.0.0.1:11434`                                                 | Private Ollama sidecar base URL used only when `RELIC_AI_EXPEDITION_MODE=ollama`.                                                                                              |
| `RELIC_AI_EXPEDITION_OLLAMA_MODEL`    | No       | `llama-test`                                                             | Ollama model ID used only when `RELIC_AI_EXPEDITION_MODE=ollama`.                                                                                                              |

### Inherited API-v1 Variables

Because the Relic server calls `createDefaultRallarServer()` from API-v1, these API-v1
variables are relevant too:

- Database and pub/sub: `RALLAR_SQL_BACKEND`, `DATABASE_URL`,
  `RALLAR_PGLITE_DATA_DIR`, `RALLAR_PGLITE_SCHEMA_INIT`, `RALLAR_DB_PUBSUB`.
- Auth and rate limits: `AUTH_REGISTRATION_MODE`, `AUTH_ADMIN_CLIENT_IDS`,
  `AUTH_STATIC_CLIENTS_MODE`, `RALLAR_STATE_STRICT_READ_AUTH`,
  `RALLAR_LOGIN_IP_RATE_LIMIT`, `RALLAR_LOGIN_USER_RATE_LIMIT`.
- ICE: `RALLAR_ICE_MODE`, `METERED_APP_NAME`, `METERED_API_KEY`,
  `METERED_REGION`.
- Timing and app inbox: `RALLAR_TIMING_LOGS`,
  `RALLAR_APP_INBOX_PHASE_TIMING`,
  `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`,
  `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`.
- API config overrides: `RALLAR_API_BASE_URL`, `RALLAR_WS_BASE_URL`.
- Black-box operator brokerage when used: `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`,
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`,
  `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`.

## apps/rallar-black-box

This is a Vite browser app and workbench. `vite.config.ts` sets
`envDir` to the repository root and exposes only `VITE_*` variables to the
client bundle. Treat `VITE_*` values as public and keep server-only
`RALLAR_*`, operator, admin, and run-token secrets outside browser builds.

### Browser Runtime Bootstrap

Every runtime bootstrap value can also be supplied as a URL query parameter.
Query parameters take precedence over environment variables.

| Variable                                                                                      | Required                                                         | Default                                                              | Usage                                                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `VITE_RALLAR_BOOTSTRAP_MODE`                                                                  | No                                                               | `local-workbench`                                                    | `control` selects control-agent mode; any other value keeps the local workbench.                               |
| `VITE_RALLAR_CONTROL_URL`                                                                     | No                                                               | `ws://localhost:5180/control`                                        | WebSocket URL for the control server.                                                                          |
| `VITE_RALLAR_AUTO_CONNECT`                                                                    | No                                                               | Enabled when mode is control-agent, otherwise disabled               | Boolean. Forces the app into control-agent mode and connects to the control server automatically.              |
| `VITE_RALLAR_PROVIDER`                                                                        | No                                                               | `simulated`                                                          | Provider mode: `simulated`, or `browser-rallar` for the real Rallar API; any other value is a bootstrap issue. |
| `VITE_RALLAR_RUN_ID`                                                                          | No                                                               | `control-run-local` in control mode; `local-workbench-run` otherwise | Control run identifier.                                                                                        |
| `VITE_RALLAR_AGENT_ID`                                                                        | No                                                               | `visible-agent-local`                                                | Control agent identifier.                                                                                      |
| `VITE_RALLAR_CONTROL_TOKEN`                                                                   | No                                                               | None                                                                 | Optional run token sent to the control server. Public in the browser bundle if set through Vite.               |
| `VITE_RALLAR_HEARTBEAT_INTERVAL_MS`                                                           | No                                                               | `10000`                                                              | Control-agent heartbeat interval in milliseconds; a non-negative integer.                                      |
| `VITE_RALLAR_STATS_INTERVAL_MS`                                                               | No                                                               | `5000`                                                               | Control-agent stats interval in milliseconds; a non-negative integer, `0` turns stats off.                     |
| `VITE_RALLAR_REPORT_UPLOAD_URL`                                                               | No                                                               | None                                                                 | Optional final-report upload endpoint.                                                                         |
| `VITE_RALLAR_ENVIRONMENT`                                                                     | No                                                               | `local`                                                              | Label included in the black-box run config.                                                                    |
| `VITE_RALLAR_API_BASE_URL`                                                                    | Required for `browser-rallar` provider                           | `https://api.example.invalid`                                        | Rallar API base URL. The simulated provider can use the default.                                               |
| `VITE_RALLAR_APPLICATION_ID`                                                                  | No                                                               | `rallar-black-box`                                                   | Rallar application scope.                                                                                      |
| `VITE_RALLAR_WORKSPACE_ID`                                                                    | No                                                               | `default`                                                            | Rallar workspace scope.                                                                                        |
| `VITE_RALLAR_ACTOR`                                                                           | No                                                               | `alice`                                                              | Actor/client label used in default runtime config.                                                             |
| `VITE_RALLAR_SESSION_ID`                                                                      | No                                                               | `visible-session-alice`                                              | Session ID used in default runtime config and restore flows.                                                   |
| `VITE_RALLAR_ROOM_ID`                                                                         | No                                                               | `rallar-black-box-room`                                              | Room/group ID used by browser-rallar flows.                                                                    |
| `VITE_RALLAR_TRANSPORT`                                                                       | No                                                               | `realtime`                                                           | Bootstrap transport: `realtime` or `messages.rtc`.                                                             |
| `VITE_RALLAR_USERNAME`                                                                        | Required for browser-rallar login unless restore-session is used | None                                                                 | Rallar login username. Public if bundled.                                                                      |
| `VITE_RALLAR_PASSWORD`                                                                        | Required for browser-rallar login unless restore-session is used | None                                                                 | Rallar login password. Public if bundled. Prefer local/test use only.                                          |
| `VITE_RALLAR_REGISTER`                                                                        | No                                                               | Disabled                                                             | Boolean. Register before login when supported.                                                                 |
| `VITE_RALLAR_RESTORE_SESSION`                                                                 | No                                                               | Disabled unless a browser auth session already exists                | Boolean. Restore the browser auth session already stored for this page.                                        |
| `VITE_RALLAR_LOGOUT_ON_CLOSE`                                                                 | No                                                               | Disabled                                                             | Boolean. Log out on real-provider cleanup.                                                                     |
| `VITE_RALLAR_LEAVE_ROOM_ON_CLOSE`                                                             | No                                                               | Enabled                                                              | Boolean. Leave room on real-provider cleanup.                                                                  |
| `VITE_RALLAR_AGENT_REGION`                                                                    | No                                                               | None                                                                 | Fleet label used by control-agent identity, fleet reports, and Fleet World Map fallback lookup.                |
| `VITE_RALLAR_AGENT_PROVIDER`                                                                  | No                                                               | None                                                                 | Fleet provider label used with region/datacenter summaries.                                                    |
| `VITE_RALLAR_AGENT_DATACENTER`                                                                | No                                                               | None                                                                 | Fleet datacenter label. Known provider/datacenter pairs can resolve approximate map coordinates.               |
| `VITE_RALLAR_AGENT_LATITUDE`                                                                  | No                                                               | None                                                                 | Explicit fleet map latitude. Used only with a valid longitude; must be from `-90` to `90`.                     |
| `VITE_RALLAR_AGENT_LONGITUDE`                                                                 | No                                                               | None                                                                 | Explicit fleet map longitude. Used only with a valid latitude; must be from `-180` to `180`.                   |
| `VITE_RALLAR_AGENT_LOCATION_LABEL`                                                            | No                                                               | None                                                                 | Human label for explicit fleet map coordinates.                                                                |
| `VITE_RALLAR_AGENT_TAGS`                                                                      | No                                                               | None                                                                 | Comma-separated fleet tags included in control-agent identity and reports.                                     |
| `VITE_RALLAR_AUTH_STORAGE`                                                                    | No                                                               | `local`                                                              | Browser auth-session storage: `local` or `session`; any other value is a bootstrap issue.                      |
| `VITE_RALLAR_RUNNER_AGENT_PREFIX`                                                             | No                                                               | None                                                                 | Agent ID prefix for runner-launched agents.                                                                    |
| `VITE_RALLAR_RUNNER_AGENT_COUNT`                                                              | No                                                               | `1`                                                                  | Number of runner-launched agents; a positive integer.                                                          |
| `VITE_RALLAR_AGENT_HOST_ID`, `VITE_RALLAR_AGENT_POOL_ID`, `VITE_RALLAR_AGENT_DEPLOYMENT_ID`   | No                                                               | None                                                                 | Fleet host, pool, and deployment labels in control-agent identity and reports.                                 |
| `VITE_RALLAR_AGENT_BROWSER_NAME`, `VITE_RALLAR_AGENT_BROWSER_VERSION`, `VITE_RALLAR_AGENT_OS` | No                                                               | None                                                                 | Fleet browser and OS labels in control-agent identity and reports.                                             |

The same fleet metadata can be supplied as URL query parameters in browser
bootstrap flows: `fleetRegion`, `fleetProvider`, `fleetDatacenter`,
`fleetHostId`, `fleetAgentPoolId`, `fleetDeploymentId`, `fleetBrowserName`,
`fleetBrowserVersion`, `fleetOs`, `fleetLatitude`, `fleetLongitude`,
`fleetLocationLabel`, and `fleetTags`.

Booleans read `1`, `true`, `yes`, `on`, `0`, `false`, `no` or `off`; `VITE_RALLAR_REGISTER` also reads
`if-needed`. A launch value a setting cannot read, such as an unknown provider, an interval or runner agent
count that is not an integer, or a coordinate that is not a number in range, is recorded as a bootstrap
issue. A control agent refuses to start while any issue is present and reports every issue in its start
failure; it never runs with a default in place of the value it was given. The fleet location is optional: a
location label, or one coordinate without the other, places no map location and is not an issue.

### Rallar Black Box Headless Worker

`apps/rallar-black-box/src/headless-worker-config.ts` reads server-side
environment variables used by the headless browser worker script, then forwards
safe values to browser agents as URL parameters.

| Variable                                                                                                                                                                                               | Required                                                                                                | Default                                                                                           | Usage                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_AGENT_REGION` / `RALLAR_BLACK_BOX_AGENT_REGION`                                                                                                                                                | No                                                                                                      | None                                                                                              | Fleet region label forwarded as `fleetRegion`.                                                                                                                                                                                                  |
| `RALLAR_AGENT_PROVIDER` / `RALLAR_BLACK_BOX_AGENT_PROVIDER`                                                                                                                                            | No                                                                                                      | None                                                                                              | Fleet provider label forwarded as `fleetProvider`.                                                                                                                                                                                              |
| `RALLAR_AGENT_DATACENTER` / `RALLAR_BLACK_BOX_AGENT_DATACENTER`                                                                                                                                        | No                                                                                                      | None                                                                                              | Fleet datacenter label forwarded as `fleetDatacenter`.                                                                                                                                                                                          |
| `RALLAR_AGENT_LATITUDE` / `RALLAR_BLACK_BOX_AGENT_LATITUDE`                                                                                                                                            | No                                                                                                      | None                                                                                              | Explicit fleet latitude forwarded as `fleetLatitude`; invalid values fail startup.                                                                                                                                                              |
| `RALLAR_AGENT_LONGITUDE` / `RALLAR_BLACK_BOX_AGENT_LONGITUDE`                                                                                                                                          | No                                                                                                      | None                                                                                              | Explicit fleet longitude forwarded as `fleetLongitude`; invalid values fail startup.                                                                                                                                                            |
| `RALLAR_AGENT_LOCATION_LABEL` / `RALLAR_BLACK_BOX_AGENT_LOCATION_LABEL`                                                                                                                                | No                                                                                                      | None                                                                                              | Human label forwarded as `fleetLocationLabel`.                                                                                                                                                                                                  |
| `RALLAR_AGENT_TAGS` / `RALLAR_BLACK_BOX_AGENT_TAGS`                                                                                                                                                    | No                                                                                                      | None                                                                                              | Comma-separated fleet tags forwarded as `fleetTags`.                                                                                                                                                                                            |
| `RALLAR_BLACK_BOX_EXIT_MODE`                                                                                                                                                                           | No                                                                                                      | `signal`                                                                                          | Worker shutdown policy. Use `after-target-distributed-run-terminal` in GitHub Actions so a headless shard exits when the target distributed run reaches `passed`, `failed`, `cancelled`, or `timed-out`; use `after-idle-ms` for a fixed lease. |
| `RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID`                                                                                                                                                           | Required when `RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal`                        | None                                                                                              | Distributed run id polled by GitHub-hosted headless workers before exiting.                                                                                                                                                                     |
| `RALLAR_CONTROL_HTTP_URL`                                                                                                                                                                              | No                                                                                                      | Derived from `RALLAR_BLACK_BOX_CONTROL_URL` by converting `ws:` to `http:` and `wss:` to `https:` | Control-server HTTP base URL used for distributed-run polling. In GitHub Actions this should point at the public Hetzner control URL, for example `https://control.rallar.intactss.com`.                                                        |
| `RALLAR_BLACK_BOX_CONTROL_TOKEN`                                                                                                                                                                       | No                                                                                                      | None                                                                                              | Legacy shared bearer token used as the browser-agent registration fallback and, when no read token is configured, Node-side control-server read polling fallback. Do not set this to a permanent admin token for public browser agents.         |
| `RALLAR_BLACK_BOX_CONTROL_READ_TOKEN`                                                                                                                                                                  | No                                                                                                      | None                                                                                              | Bearer token used only by the Node-side headless worker and controller wait scripts for protected control-server reads. Use an admin/operator token here when `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN=1`.                                          |
| `RALLAR_BLACK_BOX_AGENT_<N>_CONTROL_TOKEN`                                                                                                                                                             | No                                                                                                      | Falls back to `RALLAR_BLACK_BOX_CONTROL_TOKEN`                                                    | Per-local-agent run token forwarded as the browser `controlToken` URL parameter. GitHub-hosted shards and the Hetzner headless browser workflow mint these automatically before launch.                                                         |
| `RALLAR_BLACK_BOX_IDLE_EXIT_MS`                                                                                                                                                                        | Required when `RALLAR_BLACK_BOX_EXIT_MODE=after-idle-ms`; optional fallback for distributed-run polling | None                                                                                              | Positive millisecond timeout for fixed-lease workers. When supplied with distributed-run polling, it bounds how long a GitHub shard can wait for the operator-created run to become terminal.                                                   |
| `RALLAR_BLACK_BOX_DISTRIBUTED_POLL_INTERVAL_MS`                                                                                                                                                        | No                                                                                                      | `5000`                                                                                            | Positive millisecond interval between distributed-run status polls. GitHub Actions may lower this for faster shard shutdown after a short smoke run.                                                                                            |
| `RALLAR_BLACK_BOX_SPA_URL`                                                                                                                                                                             | Yes                                                                                                     | None                                                                                              | Black-box SPA base URL the agents open (`/headless/` is appended for the headless entry).                                                                                                                                                       |
| `RALLAR_BLACK_BOX_CONTROL_URL`                                                                                                                                                                         | Yes                                                                                                     | None                                                                                              | Control-server WebSocket (or HTTP) URL forwarded as `controlUrl`.                                                                                                                                                                               |
| `RALLAR_API_BASE_URL`                                                                                                                                                                                  | Yes                                                                                                     | None                                                                                              | Rallar API base URL forwarded as `apiBaseUrl`.                                                                                                                                                                                                  |
| `RALLAR_BLACK_BOX_RUN_ID`                                                                                                                                                                              | Yes                                                                                                     | None                                                                                              | Control run ID forwarded as `runId`.                                                                                                                                                                                                            |
| `RALLAR_BLACK_BOX_ROOM_ID`                                                                                                                                                                             | Yes                                                                                                     | None                                                                                              | Room ID forwarded as `roomId`.                                                                                                                                                                                                                  |
| `RALLAR_BLACK_BOX_USERNAME` / `RALLAR_BLACK_BOX_PASSWORD`                                                                                                                                              | Yes unless every agent has its own pair                                                                 | None                                                                                              | Shared agent login credentials.                                                                                                                                                                                                                 |
| `RALLAR_BLACK_BOX_AGENT_<N>_USERNAME` / `RALLAR_BLACK_BOX_AGENT_<N>_PASSWORD`                                                                                                                          | No                                                                                                      | Falls back to the shared pair                                                                     | Per-local-agent credentials.                                                                                                                                                                                                                    |
| `RALLAR_BLACK_BOX_AGENT_COUNT`                                                                                                                                                                         | No                                                                                                      | `1`                                                                                               | Positive number of browser agents in this worker.                                                                                                                                                                                               |
| `RALLAR_BLACK_BOX_AGENT_START_INDEX`                                                                                                                                                                   | No                                                                                                      | `1`                                                                                               | First agent ordinal; agent IDs are `<prefix>-NN`.                                                                                                                                                                                               |
| `RALLAR_BLACK_BOX_AGENT_PREFIX`                                                                                                                                                                        | No                                                                                                      | `hetzner-agent`                                                                                   | Agent ID prefix.                                                                                                                                                                                                                                |
| `RALLAR_APPLICATION_ID` / `RALLAR_BLACK_BOX_APPLICATION_ID`                                                                                                                                            | No                                                                                                      | None                                                                                              | Application scope forwarded as `applicationId`.                                                                                                                                                                                                 |
| `RALLAR_WORKSPACE_ID` / `RALLAR_BLACK_BOX_WORKSPACE_ID`                                                                                                                                                | No                                                                                                      | None                                                                                              | Workspace scope forwarded as `workspaceId`.                                                                                                                                                                                                     |
| `RALLAR_BLACK_BOX_TRANSPORT`                                                                                                                                                                           | No                                                                                                      | `realtime`                                                                                        | `realtime` or `messages.rtc`.                                                                                                                                                                                                                   |
| `RALLAR_BLACK_BOX_STATS_INTERVAL_MS` / `RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS`                                                                                                                        | No                                                                                                      | Browser defaults                                                                                  | Positive intervals forwarded to agents.                                                                                                                                                                                                         |
| `RALLAR_BLACK_BOX_REPORT_UPLOAD_URL`                                                                                                                                                                   | No                                                                                                      | None                                                                                              | Forwarded as `reportUploadUrl`.                                                                                                                                                                                                                 |
| `RALLAR_BLACK_BOX_ENVIRONMENT`                                                                                                                                                                         | No                                                                                                      | None                                                                                              | Forwarded as `environment`.                                                                                                                                                                                                                     |
| `RALLAR_AGENT_HOST_ID`, `RALLAR_AGENT_POOL_ID`, `RALLAR_AGENT_DEPLOYMENT_ID`, `RALLAR_AGENT_BROWSER_NAME`, `RALLAR_AGENT_BROWSER_VERSION`, `RALLAR_AGENT_OS` (each also as `RALLAR_BLACK_BOX_AGENT_*`) | No                                                                                                      | Browser name defaults to the engine                                                               | Fleet facts forwarded as `fleetHostId`, `fleetAgentPoolId`, `fleetDeploymentId`, `fleetBrowserName`, `fleetBrowserVersion`, `fleetOs`.                                                                                                          |
| `RALLAR_BLACK_BOX_REGISTER`, `RALLAR_BLACK_BOX_RESTORE_SESSION`, `RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE`, `RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE`                                                            | No                                                                                                      | `false`                                                                                           | Agent auth lifecycle booleans.                                                                                                                                                                                                                  |
| `RALLAR_BLACK_BOX_HEADLESS_ENTRY`                                                                                                                                                                      | No                                                                                                      | `headless`                                                                                        | `headless` or `operator-spa`.                                                                                                                                                                                                                   |
| `RALLAR_BLACK_BOX_BROWSER_ENGINE`                                                                                                                                                                      | No                                                                                                      | `chromium`                                                                                        | `chromium`, `firefox`, or `webkit`.                                                                                                                                                                                                             |
| `RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL`                                                                                                                                                                   | No                                                                                                      | `warning`                                                                                         | `warning`, `info`, or `debug`.                                                                                                                                                                                                                  |
| `RALLAR_BLACK_BOX_HEADLESS`                                                                                                                                                                            | No                                                                                                      | `true`                                                                                            | Set false to show browser windows.                                                                                                                                                                                                              |
| `RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS` / `RALLAR_BLACK_BOX_READY_TIMEOUT_MS`                                                                                                                             | No                                                                                                      | `30000` / `45000`                                                                                 | Positive browser launch and agent readiness timeouts.                                                                                                                                                                                           |

### GitHub Free Distributed Recipe Workflow

`.github/workflows/github-free-distributed-recipe.yml` runs GitHub-hosted
headless browser shards against the existing public Hetzner control plane. The
default 50-agent smoke sizing is:

```text
target_agent_count=50
agents_per_job=3
max_parallel_jobs=17
agent_prefix=controller
```

The operator runbook is
[`docs/github-actions-black-box-headless-runbook.md`](./github-actions-black-box-headless-runbook.md).

Keep `max_parallel_jobs` at or below `19` for this GitHub Free workflow because
the concurrent Hetzner operator job reserves the 20th standard hosted-job slot.
The default `agent_prefix=controller` matches the existing 50-agent role-map
manifests, which target `controller-01` through `controller-50`. Changing the
prefix requires a matching manifest or a manifest rewrite before dispatch.

Recommended GitHub Free rollout progression:

1. 2-agent health.
2. 10-agent 30-second tree.
3. 20-agent 30-second tree.
4. 50-agent 30-second tree using `target_agent_count=50`, `agents_per_job=3`,
   and `max_parallel_jobs=17`.
5. 50-agent 60-minute tree only after the 30-second run is stable.

The default GitHub Free smoke candidate is
`apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json`.
It preserves the existing role map for `controller-01` through
`controller-50` and currently uses `barrier.timeoutMs=15000`. If any 10+ agent
run reaches the staged command but misses the barrier, create a
GitHub-specific manifest copy that preserves the same command payloads,
topology metadata, role map, and expected participant count, but changes only
`distributedRunId`, display/catalog labels, and `barrier.timeoutMs` to
`60000`.

Each GitHub agent shard always mints short-lived per-agent run tokens with
`POST /runs/{runId}/agents/{agentId}/tokens` and exposes them as
`RALLAR_BLACK_BOX_AGENT_<N>_CONTROL_TOKEN` before launching the headless worker,
so the workflow works whether or not the control server sets
`RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1`.
Set the GitHub secret `RALLAR_BLACK_BOX_CONTROL_READ_TOKEN` to an admin/operator
token when protected reads or token minting require authorization. The workflow
falls back to the legacy `RALLAR_BLACK_BOX_CONTROL_TOKEN` secret for older
deployments, but that token is no longer passed directly into browser-agent
URLs by the GitHub Free workflow.

The regular `.github/workflows/hetzner-headless-browsers.yml` workflow uses the
same token endpoint for `action=start` and `action=restart`, including when the
dispatch leaves `run_id` blank and the workflow generates one before copying the
remote worker environment.

### Full-Stack Playwright Startup

| Variable                                                   | Required              | Default                 | Usage                                                                                                                                  |
| ---------------------------------------------------------- | --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_FULL_STACK`                              | No                    | Disabled                | `1` or `true` enables API-v1 startup in `apps/rallar-black-box/playwright.full-stack.config.ts`.                                       |
| `RALLAR_BLACK_BOX_API_MODE`                                | No                    | `postgres`              | Full-stack API server mode. Supported values: `postgres`, `memory`. Memory mode starts API-v1 without env files or `DATABASE_URL`.     |
| `VITE_RALLAR_API_BASE_URL`                                 | No                    | `http://localhost:8080` | Full-stack API base URL. The Playwright config derives API-v1 `PORT`, `RALLAR_API_BASE_URL`, and `RALLAR_WS_BASE_URL` from this value. |
| `VITE_RALLAR_SPA_BASE_URL`                                 | No                    | `http://localhost:5176` | Full-stack SPA base URL. The Playwright config derives the Vite port and API CORS origins from this value.                             |
| `RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API`              | No                    | Disabled                | `1` or `true` refuses to reuse an existing API server; valid only with `postgres` mode.                                                |
| `RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER`                        | No                    | Disabled                | `1` starts two additional PostgreSQL API-v1 processes for the live RTC matrix; ordinary full-stack runs remain single-process.         |
| `VITE_RALLAR_API_BASE_URL_B`, `VITE_RALLAR_API_BASE_URL_C` | With RTC cluster mode | None                    | Distinct API origins for browser agents B and C; agent A uses `VITE_RALLAR_API_BASE_URL`.                                              |
| `RALLAR_BLACK_BOX_CONTROL_BASE_URL`                        | No                    | `http://127.0.0.1:5180` | Control-server base URL; the Playwright config derives the control port from it.                                                       |
| `RALLAR_BLACK_BOX_EXHAUSTIVE_WORKERS`                      | No                    | `4`                     | Worker count for `playwright.exhaustive.config.ts`.                                                                                    |

Both modes select `RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory` and use
bounded full-stack fixture credentials. Memory mode takes its database and ICE
behavior directly from that profile. PostgreSQL mode applies only the
run-specific `postgres`, disabled schema bootstrap, and PostgreSQL pub/sub
overrides.

### Rallar Black Box Playwright Test Inputs

These are read by tests under `tests/playwright/rallar-black-box`.

| Variable                                    | Required | Default                          | Usage                                                                                                 |
| ------------------------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES`      | No       | Disabled                         | Boolean gate for live distributed recipe tests.                                                       |
| `RALLAR_BLACK_BOX_LIVE_DISTRIBUTED_RECIPES` | No       | Disabled                         | Alternate boolean gate for live distributed recipe tests.                                             |
| `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX`          | No       | Disabled                         | Boolean gate for the live three-browser RTC matrix.                                                   |
| `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS`       | No       | Disabled                         | Boolean gate for exhaustive live RTC scenarios.                                                       |
| `RALLAR_BLACK_BOX_ALM_SCOPE`                | No       | `smoke`                          | Scenario coverage for the ALM conformance lane. Supported values: `smoke`, `full`.                    |
| `RALLAR_BLACK_BOX_ALM_SKIP`                 | No       | Empty                            | Comma-separated ALM conformance scenario IDs withheld from the lane.                                  |
| `RALLAR_BLACK_BOX_ALM_CARRIERS`             | No       | All carriers                     | Comma-separated ALM conformance carriers (`ws`, `rtc`, `rtc-with-ws-fallback`).                       |
| `VITE_RALLAR_GROUP_ID`                      | No       | None                             | Alias for `VITE_RALLAR_ROOM_ID` in the live RTC matrix.                                               |
| `VITE_RALLAR_CLIENT_ID`                     | No       | Derived from username or default | Client ID for generic agent A full-stack helpers and restore-session smoke.                           |
| `VITE_RALLAR_EXPIRES_AT_EPOCH_MS`           | No       | Future test fallback             | Expiry timestamp for generic restored-session smoke.                                                  |
| `VITE_RALLAR_REAL_PEER_IDS`                 | No       | Empty                            | Comma-separated peer IDs for live real-provider direct or multicast sends.                            |
| `VITE_RALLAR_MESSAGES_RTC_TYPE_ID`          | No       | Test default                     | Type ID for `messages.rtc` tests.                                                                     |
| `VITE_RALLAR_TYPE_ID`                       | No       | Test default                     | Fallback type ID for `messages.rtc` tests.                                                            |
| `VITE_RALLAR_MESSAGES_RTC_TOPIC_ID`         | No       | Test default                     | Topic ID for `messages.rtc` tests.                                                                    |
| `VITE_RALLAR_TOPIC_ID`                      | No       | Test default                     | Fallback topic ID for `messages.rtc` tests.                                                           |
| `RALLAR_BLACK_BOX_DIRECTOR`                 | No       | Disabled                         | Boolean gate for the full-stack director orchestration spec.                                          |
| `RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE`      | No       | Disabled                         | `1` runs the local control-foundation smoke against `http://localhost:5180`.                          |
| `RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK`      | No       | Disabled                         | Boolean gate for the live RTC retention soak; pair with `RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100`. |
| `RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES`    | No       | None                             | Retention soak cycle count recorded in evidence; the evidence check expects `100`.                    |
| `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR`  | No       | None                             | Directory for live RTC matrix diagnostics output.                                                     |
| `VITE_RALLAR_TOKEN`                         | No       | None                             | Access token for the generic restored-session real-provider smoke.                                    |

Agent-specific test variables are accepted in both long and short forms in
some tests:

| Pattern                                                                                                                         | Usage                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `VITE_RALLAR_AGENT_A_USERNAME`, `VITE_RALLAR_AGENT_B_USERNAME`, `VITE_RALLAR_AGENT_C_USERNAME`                                  | Per-agent login usernames. Agent A can fall back to `VITE_RALLAR_USERNAME`.                                        |
| `VITE_RALLAR_AGENT_A_PASSWORD`, `VITE_RALLAR_AGENT_B_PASSWORD`, `VITE_RALLAR_AGENT_C_PASSWORD`                                  | Per-agent login passwords. Agent A can fall back to `VITE_RALLAR_PASSWORD`.                                        |
| `VITE_RALLAR_AGENT_A_TOKEN`, `VITE_RALLAR_AGENT_B_TOKEN`, `VITE_RALLAR_AGENT_C_TOKEN`                                           | Per-agent restored-session access tokens.                                                                          |
| `VITE_RALLAR_AGENT_A_CLIENT_ID`, `VITE_RALLAR_AGENT_B_CLIENT_ID`, `VITE_RALLAR_AGENT_C_CLIENT_ID`                               | Per-agent restored-session client IDs.                                                                             |
| `VITE_RALLAR_AGENT_A_SESSION_ID`, `VITE_RALLAR_AGENT_B_SESSION_ID`, `VITE_RALLAR_AGENT_C_SESSION_ID`                            | Per-agent restored-session IDs.                                                                                    |
| `VITE_RALLAR_AGENT_A_EXPIRES_AT_EPOCH_MS`, `VITE_RALLAR_AGENT_B_EXPIRES_AT_EPOCH_MS`, `VITE_RALLAR_AGENT_C_EXPIRES_AT_EPOCH_MS` | Per-agent restored-session expiry timestamps.                                                                      |
| `VITE_RALLAR_AGENT_A_ACTOR`, `VITE_RALLAR_AGENT_B_ACTOR`, `VITE_RALLAR_AGENT_C_ACTOR`                                           | Per-agent actor labels.                                                                                            |
| `VITE_RALLAR_A_*`, `VITE_RALLAR_B_*`, `VITE_RALLAR_C_*`                                                                         | Short aliases accepted by some live tests for username, password, token, client ID, session ID, expiry, and actor. |

## apps/rallar-black-box-headless

This is the Vite headless agent page served under `/headless/` (dev port `5179`). Like
`apps/rallar-black-box`, `vite.config.ts` sets `envDir` to the repository root and exposes only `VITE_*`
variables. It reads the same browser runtime bootstrap keys listed under
[Browser Runtime Bootstrap](#browser-runtime-bootstrap). `apps/rallar-black-box-headless/scripts/rendered-smoke.ts` reads
`RALLAR_BLACK_BOX_HEADLESS_PREVIEW_URL` for the rendered smoke target.

## apps/rallar-black-box-control-server

This is a Deno control server. It does not load an env file by itself; set
variables in the shell or through the parent script/process.

| Variable                                        | Required | Default                           | Usage                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                          | No       | `5180`                            | HTTP and WebSocket listen port. Parsed with `Number(...)`.                                                                                                                                                                                                                            |
| `RALLAR_PRODUCTION_HARDENING`                   | No       | Disabled                          | `1`, `true`, `yes`, or `on` enables production startup validation for black-box control.                                                                                                                                                                                              |
| `RALLAR_BLACK_BOX_ALLOWED_COMMANDS`             | No       | All command kinds                 | Comma-separated allow-list of command kinds accepted by the control service.                                                                                                                                                                                                          |
| `RALLAR_BLACK_BOX_ALLOWED_ORIGINS`              | No       | No origin restriction             | Comma-separated request origins accepted by the general request policy.                                                                                                                                                                                                               |
| `RALLAR_BLACK_BOX_REQUIRE_TLS`                  | No       | Disabled                          | Boolean. Rejects non-HTTPS requests unless `x-forwarded-proto` is `https`.                                                                                                                                                                                                            |
| `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN`            | No       | Disabled                          | Boolean. Requires a valid run token for run/agent operations even when no token has been issued yet.                                                                                                                                                                                  |
| `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN`           | No       | Disabled                          | Boolean. When enabled, run, fleet, distributed-run, and artifact GET routes require the same admin/operator authorization as mutations. `/health` and docs remain public.                                                                                                             |
| `RALLAR_BLACK_BOX_ADMIN_TOKEN`                  | No       | None                              | Admin token for creating distributed runs and other admin operations. Admin authorization is open only when both this and `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` are unset (local use). Prefer operator tokens plus optional break-glass admin token in production.                 |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`        | No       | None                              | HMAC secret for accepting logged-in operator tokens issued by API-v1. Keep this equal to API-v1 `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`.                                                                                                                                             |
| `RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS`             | No       | `900000`                          | Default issued run-token TTL in milliseconds. Non-negative integer.                                                                                                                                                                                                                   |
| `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES`            | No       | `2000000`                         | Max JSON request body size. Non-negative integer.                                                                                                                                                                                                                                     |
| `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX`       | No       | `120`                             | Max accepted commands per rate-limit window. Non-negative integer.                                                                                                                                                                                                                    |
| `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS` | No       | `60000`                           | Command rate-limit window in milliseconds. Non-negative integer.                                                                                                                                                                                                                      |
| `RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS`           | No       | No destination host restriction   | Comma-separated host allow-list for browser `http.request` commands. Supports exact host/hostname and `*.example.com` style suffixes.                                                                                                                                                 |
| `RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS`         | No       | No destination origin restriction | Comma-separated origin allow-list for browser `http.request` commands.                                                                                                                                                                                                                |
| `RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS`             | No       | No destination host restriction   | Comma-separated host allow-list for browser `ws.open` commands. Supports exact host/hostname and `*.example.com` style suffixes.                                                                                                                                                      |
| `RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS`           | No       | No destination origin restriction | Comma-separated origin allow-list for browser `ws.open` commands.                                                                                                                                                                                                                     |
| `RALLAR_BLACK_BOX_STORAGE_DIR`                  | No       | None                              | Directory for persisted `control-snapshot.json` and per-run artifact JSONL under `runs/`. Each run's directory name is the run ID with characters outside `[a-z0-9-]` escaped as `_` plus four lowercase hex digits. If unset, control runs and artifact evidence are in-memory only. |
| `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`           | No       | `0`                               | Max retained runs for persistence/cleanup. `0` means no retention cap.                                                                                                                                                                                                                |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_COMMANDS`    | No       | `500`                             | Max recent command snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                         |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_RESULTS`     | No       | `500`                             | Max recent result snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                          |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_EVENTS`      | No       | `1000`                            | Max recent event snapshots persisted per run. Keeps high-volume RTC runs from forcing huge snapshot writes. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                             |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_STATS`       | No       | `200`                             | Max recent stats snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                           |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_REPORTS`     | No       | `100`                             | Max recent report snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                          |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_HEARTBEATS`  | No       | `100`                             | Max recent heartbeat snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                       |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS`      | No       | `1000`                            | Max recent command envelopes retained in heap per run. Active distributed command links and pending commands are preserved. Use `all`, `unbounded`, or `none` for no cap.                                                                                                             |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS`       | No       | `1000`                            | Max recent compact result envelopes retained in heap per run. Full result artifact rows are written to storage when `RALLAR_BLACK_BOX_STORAGE_DIR` is set.                                                                                                                            |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS`        | No       | `2000`                            | Max recent event envelopes retained in heap per run. Full event artifact rows are written to storage when `RALLAR_BLACK_BOX_STORAGE_DIR` is set.                                                                                                                                      |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_STATS`         | No       | `500`                             | Max recent stats envelopes retained in heap per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                    |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS`       | No       | `20`                              | Max recent compact report envelopes retained in heap per run. Report `results` and `events` payloads are omitted server-side.                                                                                                                                                         |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_HEARTBEATS`    | No       | `500`                             | Max recent heartbeat envelopes retained in heap per run. Use `all`, `unbounded`, or `none` for no cap.                                                                                                                                                                                |

Boolean variables accept `1`, `true`, `yes`, or `on` (case-insensitive); anything else is false. Numeric
variables that are negative or not integers silently fall back to their defaults. Every `*_RETAIN_*` and
`*_PERSIST_*` bound accepts `all`, `unbounded`, or `none` for no cap.

Wildcard CORS, unset admin/operator auth, optional run tokens, optional read
tokens, in-memory storage, and unbounded retention are local-only defaults.
Enable `RALLAR_PRODUCTION_HARDENING=1` for production so these settings fail
closed at startup.

## Repository-Level Test And Infrastructure Variables

These are not owned by a single app, but they affect app test runs or local
infrastructure.

### RallarAI Live Evaluation

Normal CI uses deterministic mock providers. These variables opt into live
provider checks for local or scheduled runs.

| Variable                    | Required | Default                  | Usage                                                                                                                          |
| --------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `RALLAR_AI_LIVE_OLLAMA`     | No       | Disabled                 | `1`, `true`, `yes`, or `on` enables the live Ollama evaluation harness.                                                        |
| `RALLAR_AI_OLLAMA_BASE_URL` | No       | `http://127.0.0.1:11434` | Ollama sidecar base URL for live evaluation. Keep private to the server/test network.                                          |
| `RALLAR_AI_OLLAMA_MODEL`    | No       | `llama-test` in the test | Ollama model ID used by the live evaluation harness.                                                                           |
| `RALLAR_AI_LIVE_WEBLLM`     | No       | Disabled                 | `1` enables browser-run WebLLM live evaluation, read by AR Eye Hunter's `runArenaWebLlmLiveEvaluationIfEnabled`; needs WebGPU. |

### Playwright

| Variable | Required | Default | Usage                                                                                                                                                                                                                                                         |
| -------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`     | No       | Unset   | When truthy, `apps/relic-hunters-v1/playwright.config.ts` forbids `.only`, enables 2 retries, switches the reporter to HTML plus list, and disables `reuseExistingServer`; the `apps/rallar-black-box` Playwright configs only disable `reuseExistingServer`. |

### Postgres Infrastructure

| Variable                      | Required                                      | Default                                                         | Usage                                                                                                                                                  |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_USER`               | Container config                              | `app` in `docker-compose.yml`                                   | Postgres container user.                                                                                                                               |
| `POSTGRES_PASSWORD`           | Container config                              | `app` in `docker-compose.yml`                                   | Postgres container password.                                                                                                                           |
| `POSTGRES_DB`                 | Container config                              | `appdb` in `docker-compose.yml`                                 | Postgres container database.                                                                                                                           |
| `RALLAR_POSTGRES_INTEGRATION` | No                                            | Disabled                                                        | `1` enables the dedicated real-PostgreSQL shared-server integration suites. These suites are excluded from the default unit-test discovery.            |
| `DATABASE_URL`                | Required when `RALLAR_POSTGRES_INTEGRATION=1` | Root script fallback: `postgres://app:app@localhost:5432/appdb` | Used by Postgres integration tests and worker fixtures. Also used by API-v1 as described above.                                                        |
| `RALLAR_EXPIRY_WORKER_INPUT`  | Worker-internal                               | None                                                            | JSON payload passed from the Postgres concurrency tests to `packages/tests/shared-server/integration/postgres/test-support/postgres-expiry-worker.ts`. |

Start and migrate the local test database, then run the reusable repository and
concurrency suite followed by the isolated presence-expiry suite:

```bash
npm run db:test:up
npm run test:postgres:integration
npm run test:postgres:presence-expiry
```

Presence-expiry runs last because it deliberately retains fixed-ID outbox
evidence that can interfere with later global outbox workers.

### Shared Black-Box Runner

The shared black-box runner can resolve variables from arbitrary recipe
descriptors using `env` or `fromEnv`. The fixed variables below are used by
bundled live recipes, preflight checks, and remote-browser providers.

| Variable                            | Required                                                  | Default                                                                                                     | Usage                                                                                             |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `RALLAR_API_BASE_URL`               | Required for live shared-runner Rallar API recipes        | `https://api.example.com` in dry validation helpers; some preflight docs default to `http://localhost:8080` | Base URL for a live Rallar API service.                                                           |
| `RALLAR_ROOM_ID`                    | Required by live browser validation helper                | `room-1` in dry validation helper                                                                           | Room/group ID used by live browser validation.                                                    |
| `RALLAR_ALICE_USERNAME`             | Required by live browser validation and many live recipes | `alice` in dry validation helper                                                                            | Alice test user.                                                                                  |
| `RALLAR_ALICE_PASSWORD`             | Required by live browser validation and many live recipes | `secret` in dry validation helper                                                                           | Alice test password. Treated as secret in redaction.                                              |
| `RALLAR_BOB_USERNAME`               | Required by live browser validation and many live recipes | `bob` in dry validation helper                                                                              | Bob test user.                                                                                    |
| `RALLAR_BOB_PASSWORD`               | Required by live browser validation and many live recipes | `secret` in dry validation helper                                                                           | Bob test password. Treated as secret in redaction.                                                |
| `RALLAR_MESSAGE_TYPE_ID`            | No                                                        | `black-box.chat.message`                                                                                    | Message type ID for shared live browser validation.                                               |
| `RALLAR_TOPIC_ID`                   | No                                                        | `black-box.chat`                                                                                            | Topic ID for shared live browser validation.                                                      |
| `RALLAR_BLACK_BOX_CONTROL_BASE_URL` | No                                                        | `http://localhost:5180` (remote-browser provider); `http://127.0.0.1:5180` (full-stack Playwright)          | Base URL for the black-box control server. A recipe `control` block or runner option outranks it. |
| `RALLAR_BLACK_BOX_RUN_ID`           | No                                                        | `remote-browser-run`                                                                                        | Run ID for the remote browser provider.                                                           |
| `RALLAR_BLACK_BOX_AGENT_ID`         | Required by some remote-browser-control live recipes      | `visible-agent-local`                                                                                       | Agent ID for the remote browser provider.                                                         |
| `RALLAR_BLACK_BOX_CONTROL_TOKEN`    | No                                                        | None                                                                                                        | Control token used by the remote browser provider.                                                |
| `RALLAR_BB_USERNAME`                | No                                                        | None                                                                                                        | Generic fallback username for live preflight credential checks.                                   |
| `RALLAR_BB_PASSWORD`                | No                                                        | None                                                                                                        | Generic fallback password for live preflight credential checks.                                   |
| `RALLAR_BB_PREFLIGHT_GROUP_ID`      | No                                                        | `bb-live-preflight`                                                                                         | Group ID used by live preflight.                                                                  |
| `RALLAR_BB_GROUP_ID`                | No                                                        | `bb-live-preflight` fallback                                                                                | Recipe/preflight group ID variable.                                                               |
| `RALLAR_BB_SOAK_GROUP_ID`           | No                                                        | `bb-live-preflight` fallback                                                                                | Soak recipe/preflight group ID variable.                                                          |
| `RALLAR_BB_APPLICATION_ID`          | No                                                        | `black-box-app`                                                                                             | Application ID used by live preflight group setup.                                                |
| `RALLAR_BB_WORKSPACE_ID`            | No                                                        | `default`                                                                                                   | Workspace ID used by live preflight group setup.                                                  |
| `RALLAR_BB_GROUP_NAME`              | No                                                        | Group ID                                                                                                    | Group display name used by live preflight group setup.                                            |
| `RALLAR_PREFLIGHT_CORS_ORIGIN`      | No                                                        | None                                                                                                        | CORS origin used by shared-runner live preflight checks when configured.                          |

The api-v1 black-box runner (`npm run test:api-v1:black-box:*`) sets these for recipes; do not set them by
hand: `RALLAR_BB_RUN_ID` (also part of the default preflight group ID
`bb-live-preflight-<entryId>-<runId>`), `RALLAR_BB_EXECUTION_TOKEN`, `RALLAR_STATE_WRITE_EVIDENCE_OUTPUT`,
`RALLAR_API_BASE_URL_SECONDARY`, `RALLAR_WS_BASE_URL_SECONDARY`, `RALLAR_API_BASE_URL_TERTIARY`,
`RALLAR_WS_BASE_URL_TERTIARY`, and `RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR`.
