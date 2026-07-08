# Environment Variables

This document inventories environment variables used by the apps in this
repository, plus the repository-level test and infrastructure variables that
drive those apps.

Last reviewed: 2026-06-28.

## Conventions

- Deno server apps read environment variables at runtime through `Deno.env`.
- Vite browser apps read variables through `import.meta.env`. Those values are
  embedded into the browser bundle and are public. Do not put production secrets
  in `VITE_*`, `API_*`, or any prefix exposed by a Vite app.
- Boolean readers generally treat `1`, `true`, `yes`, or `on` as enabled. Some
  code paths only check `1` and `true`; those cases are called out below.
- Comma-separated variables are trimmed and empty entries are ignored.
- Values from local `.env` files are intentionally not recorded here. Only
  variable names and behavior are documented.
- Production guardrails are enabled with `RALLAR_PRODUCTION_HARDENING=1` or
  `ENVIRONMENT=prod` / `ENVIRONMENT=production`. See
  [Production Env Hardening Checklist](./production-env-hardening-checklist.md).

## Environment Files Found

| File                                     | Variables present                                                                                                                         | Notes                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env`                                   | `VITE_RALLAR_PROVIDER`, `VITE_RALLAR_API_BASE_URL`, `VITE_RALLAR_ROOM_ID`, `VITE_RALLAR_USERNAME`, `VITE_RALLAR_PASSWORD`, `CORS_ORIGINS` | Read from repo root by some Vite and root scripts. `apps/rallar-black-box` now exposes only `VITE_*` values to the browser bundle. API-v1 may receive this file through root npm scripts.  |
| `apps/api-v1/.env`                       | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`, `CORS_ORIGINS`                                                                     | Loaded by API-v1 when run from `apps/api-v1`; also passed by root black-box API scripts.                                                                                                  |
| `apps/api-v1/.env.local`                 | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`, `CORS_ORIGINS`                                                                     | Local override file used by root black-box API scripts and by Relic server startup.                                                                                                       |
| `apps/rallar-black-box/.env.local`       | `VITE_RALLAR_PROVIDER`, `VITE_RALLAR_API_BASE_URL`, `VITE_RALLAR_ROOM_ID`, `VITE_RALLAR_USERNAME`, `VITE_RALLAR_PASSWORD`, `CORS_ORIGINS` | Present, but current `apps/rallar-black-box/vite.config.ts` uses repo-root `envDir`, so this file is not loaded by Vite unless the config changes or variables are exported by the shell. Only `VITE_*` values are browser-exposed. |
| `apps/relic-hunter-server-v1/.env.local` | `METERED_APP_NAME`, `METERED_API_KEY`, `DATABASE_URL`                                                                                     | Loaded explicitly by `apps/relic-hunter-server-v1/src/main.ts`.                                                                                                                           |
| `apps/relic-hunters-v1/.env`             | `API_BASE_URL`                                                                                                                            | Loaded by Vite for the Relic Hunters browser app.                                                                                                                                         |
| `apps/relic-hunters-v1/.env.local`       | `API_BASE_URL`                                                                                                                            | Local Vite override for the Relic Hunters browser app.                                                                                                                                    |

## apps/api-v1

API-v1 is a Deno/Hono server. `src/main.ts` imports
`jsr:@std/dotenv/load`, so `.env` in the current working directory is loaded
when the app starts. Root scripts additionally pass
`--env-file=apps/api-v1/.env.local --env-file=apps/api-v1/.env --env-file=.env`
for some Rallar Black Box runs.

### Server

| Variable              | Required | Default                                                                                               | Usage                                                                                                                                 |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | No       | `8080`                                                                                                | HTTP listen port. Must be an integer from `1` to `65535`.                                                                             |
| `CORS_ORIGINS`        | No       | `http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176`             | Allowed browser origins for `/api/*`. Use `*` to reflect any request origin.                                                          |
| `ENVIRONMENT`         | No       | `dev`                                                                                                 | Selects `resources/web-config-dev.json` or `resources/web-config-prod.json` for `/api/config`. Supported values are `dev` and `prod`. |
| `RALLAR_PRODUCTION_HARDENING` | No | Disabled | `1`, `true`, `yes`, or `on` enables production startup validation. `ENVIRONMENT=prod` or `production` also enables it. |
| `RALLAR_API_BASE_URL` | No       | From selected web config                                                                              | Runtime override for `/api/config.apiBaseUrl`. Takes precedence over `API_BASE_URL`. Trailing slash is removed.                       |
| `API_BASE_URL`        | No       | From selected web config                                                                              | Secondary runtime override for `/api/config.apiBaseUrl`.                                                                              |
| `RALLAR_WS_BASE_URL`  | No       | Derived from `RALLAR_API_BASE_URL` or `API_BASE_URL` when present, otherwise from selected web config | Runtime override for `/api/config.wsBaseUrl`. Trailing slash is removed.                                                              |
| `RALLAR_STATE_STRICT_READ_AUTH` | No | Disabled | `/api/state/*` is already authenticated. `1`, `true`, `yes`, or `on` additionally applies strict full-state read authorization to client/group list, snapshot, and event reads. |

### Database

| Variable                    | Required                                           | Default                                       | Usage                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_SQL_BACKEND`        | No                                                 | `postgres`                                    | Selects SQL backend. Supported values: `postgres`, `pglite-memory`, `pglite-file`.                                                                                                     |
| `DATABASE_URL`              | Required only when `RALLAR_SQL_BACKEND=postgres`   | None                                          | Postgres connection URL used by runtime repositories and Prisma. Ignored by PGlite modes. If the URL contains `schema=...`, API-v1 converts it to `search_path=...` for `postgres.js`. |
| `RALLAR_PGLITE_DATA_DIR`    | Required only for `RALLAR_SQL_BACKEND=pglite-file` | `memory://` for `pglite-memory`               | PGlite storage location. `pglite-file` requires a filesystem path and rejects `memory://`.                                                                                             |
| `RALLAR_PGLITE_SCHEMA_INIT` | No                                                 | `disabled` for `postgres`; `auto` for PGlite  | PGlite schema bootstrap mode. Supported values: `auto`, `disabled`. `auto` is invalid with `postgres`.                                                                                 |
| `RALLAR_DB_PUBSUB`          | No                                                 | `postgres` with Postgres; `local` with PGlite | Queue pub/sub mode. Supported values: `postgres`, `local`, `disabled`. `postgres` requires `RALLAR_SQL_BACKEND=postgres`.                                                              |

### Auth And Rate Limits

| Variable                       | Required | Default  | Usage                                                                                                                                |
| ------------------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_REGISTRATION_MODE`       | No       | `public` | When set to `admin`, `/api/auth/register` requires an authenticated admin client. Other values behave like public registration.      |
| `AUTH_ADMIN_CLIENT_IDS`        | No       | `admin`  | Comma-separated client IDs allowed to register users when `AUTH_REGISTRATION_MODE=admin`.                                            |
| `AUTH_STATIC_CLIENTS_MODE`     | No       | `demo`   | `demo` enables bundled local clients such as `admin/admin`, `user/user`, and tests. `disabled` removes static clients from login and registration conflict checks. |
| `RALLAR_LOGIN_IP_RATE_LIMIT`   | No       | `30`     | Login attempts per client IP per 60 seconds. Must be a positive integer.                                                             |
| `RALLAR_LOGIN_USER_RATE_LIMIT` | No       | `5`      | Login attempts per client IP plus username per 60 seconds. Must be a positive integer. Root memory-mode scripts raise this to `100`. |

### Black Box Operator Tokens

| Variable                                      | Required | Default      | Usage                                                                                                                                                         |
| --------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`      | Yes for `/api/black-box/control-token` | None         | HMAC secret used by API-v1 to issue short-lived control-server operator tokens. The same value must be configured on the black-box control server.             |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`      | No       | `86400000`   | TTL for logged-in operator tokens. Production hardening requires an explicit positive TTL. Prefer short TTLs and bearer headers.     |
| `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`        | No       | Any logged-in user | Optional comma-separated allow-list of authenticated client IDs that may request `/api/black-box/control-token`. Production hardening requires an explicit allow-list. |

### ICE / WebRTC

| Variable                                   | Required                                                                   | Default                         | Usage                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_ICE_MODE`                          | No                                                                         | `metered`                       | ICE provider. Supported values: `metered`, `local`. `local` returns an empty ICE server list and avoids Metered API calls. |
| `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`    | No                                                                         | RTC topology `degreeLimit`, `5` | Positive integer cap for accepted RTC RTT reporting edges per endpoint. Invalid values fall back to the topology degree.   |
| `METERED_APP_NAME`                         | Required when `RALLAR_ICE_MODE=metered` and `/api/webrtc/ice` is requested | None                            | Metered TURN app name. Used in `https://<app>.metered.live/...`.                                                           |
| `METERED_API_KEY`                          | Required when `RALLAR_ICE_MODE=metered` and `/api/webrtc/ice` is requested | None                            | Metered TURN API key. Server-only secret.                                                                                  |
| `METERED_REGION`                           | No                                                                         | Empty string                    | Optional Metered TURN region query parameter.                                                                              |

### Timing And App Inbox Tuning

| Variable                                      | Required | Default | Usage                                                                         |
| --------------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `RALLAR_TIMING_LOGS`                          | No       | Enabled | Enables console timing sink. Values `0`, `false`, `no`, and `off` disable it. |
| `RALLAR_APP_INBOX_PHASE_TIMING`               | No       | `false` | Enables phase timing in app inbox processing.                                 |
| `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`        | No       | `30000` | Max app inbox wait time. Invalid numbers fall back.                           |
| `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`     | No       | `250`   | Initial app inbox retry interval. Invalid numbers fall back.                  |
| `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS` | No       | `1000`  | Max app inbox retry interval. Invalid numbers fall back.                      |
| `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`          | No       | `0.1`   | App inbox retry jitter ratio. Invalid numbers fall back.                      |

### Scripts

| Script                                                                            | Variables set by script                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd apps/api-v1 && deno task start:memory`                                        | `RALLAR_SQL_BACKEND=pglite-memory`, `RALLAR_PGLITE_DATA_DIR=memory://`, `RALLAR_PGLITE_SCHEMA_INIT=auto`, `RALLAR_DB_PUBSUB=local`, `RALLAR_ICE_MODE=local`, `RALLAR_LOGIN_USER_RATE_LIMIT=100` |
| `npm run dev:rallar:api` and `npm run start:rallar:api`                           | `CORS_ORIGINS=http://localhost:5176,http://127.0.0.1:5176`, plus app and root env files. The older `dev:rallar-black-box:api-v1` and `start:rallar-black-box:api-v1` aliases still work.       |
| `npm run start:rallar:api:memory`                                                 | Same CORS origin plus API-v1 memory-mode variables. The older `start:rallar-black-box:api-v1:memory` alias still works.                                                                         |

## apps/ar-eye-hunter-v1

This is a Vite browser app. `vite.config.ts` exposes `VITE_*` and `API_*`
variables to the client bundle.

| Variable                         | Required | Default                                | Usage                                                                                                                                                                                        |
| -------------------------------- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                   | Yes      | None                                   | Read from `import.meta.env` at startup. Configures the shared browser Rallar API client. The app throws `Missing API_BASE_URL` if it is absent.                                              |
| `VITE_RALLAR_BROWSER_AI`         | No       | `mock`                                 | Browser RallarAI mode for app-local chaos director and avatar cosmetics. `webllm` attempts real in-browser WebLLM, `mock` uses the deterministic browser provider, and `off` disables.      |
| `VITE_RALLAR_BROWSER_AI_ENABLED` | No       | Enabled                                | Optional boolean override. `false`, `0`, `no`, or `off` disables browser RallarAI even if `VITE_RALLAR_BROWSER_AI=webllm`.                                                                  |
| `VITE_RALLAR_WEBLLM_MODEL`       | No       | `Llama-3.2-1B-Instruct-q4f16_1-MLC`    | WebLLM model ID used when `VITE_RALLAR_BROWSER_AI=webllm`. Choose a small prebuilt WebLLM model for iPad/phone safety.                                                                       |
| `VITE_RALLAR_WEBLLM_FALLBACK`    | No       | `mock`                                 | Fallback when WebGPU or WebLLM generation is unavailable. `mock` keeps gameplay moving with deterministic proposals; `off` makes browser RallarAI unavailable instead.                       |

The app defaults browser RallarAI to enabled with the deterministic in-browser
provider. The GitHub Cloudflare Pages build exports
`VITE_RALLAR_BROWSER_AI=webllm`, `VITE_RALLAR_BROWSER_AI_ENABLED=true`, and
`VITE_RALLAR_WEBLLM_MODEL=Llama-3.2-1B-Instruct-q4f16_1-MLC` so production
attempts real browser WebLLM first and falls back to mock when needed. These
are public Vite values; do not put provider secrets in `VITE_*` variables.

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

| Variable                                | Required | Default                                                             | Usage                                                                                                                                           |
| --------------------------------------- | -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                  | No       | `8090`                                                              | HTTP listen port. Parsed with `Number(...)`; no range validation is applied here.                                                               |
| `CORS_ORIGINS`                          | No       | `http://localhost:5173,http://localhost:5174,http://localhost:5175` | Allowed browser origins for `/api/*`. Use `*` to reflect any request origin.                                                                    |
| `ENVIRONMENT`                           | No       | `dev`                                                               | Selects `resources/web-config-dev.json` or `resources/web-config-prod.json` for the Relic server config. Supported values are `dev` and `prod`. |
| `RELIC_REST_AUTH_MODE`                  | No       | `authenticated`                                                     | `authenticated` requires login only. `group-policy` requires full group read permission for snapshots, room send permission for commands, and active owner/admin permission for reset. |
| `RELIC_AI_EXPEDITION_MODE`              | No       | `off`                                                               | Optional server-side expedition setup generation. Supported values: `off`, `mock`, and `ollama`.                                                |
| `RELIC_AI_EXPEDITION_TIMEOUT_MS`        | No       | `15000`                                                             | Timeout for server-side expedition blueprint generation before procedural fallback. Must be a positive integer.                                  |
| `RELIC_AI_EXPEDITION_OLLAMA_BASE_URL`   | No       | `http://127.0.0.1:11434`                                            | Private Ollama sidecar base URL used only when `RELIC_AI_EXPEDITION_MODE=ollama`.                                                               |
| `RELIC_AI_EXPEDITION_OLLAMA_MODEL`      | No       | `llama-test`                                                        | Ollama model ID used only when `RELIC_AI_EXPEDITION_MODE=ollama`.                                                                               |

### Inherited API-v1 Variables

Because the Relic server calls `createRallarServer()` from API-v1, these API-v1
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
- API config overrides: `RALLAR_API_BASE_URL`, `API_BASE_URL`,
  `RALLAR_WS_BASE_URL`.
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

| Variable                            | Required                                                         | Default                                                              | Usage                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `VITE_RALLAR_BOOTSTRAP_MODE`        | No                                                               | `local-workbench`                                                    | `control` and `control-agent` both select control-agent mode; any other value falls back to local workbench.   |
| `VITE_RALLAR_CONTROL_URL`           | No                                                               | `ws://localhost:5180/control`                                        | WebSocket URL for the control server.                                                                          |
| `VITE_RALLAR_AUTO_CONNECT`          | No                                                               | Enabled when mode is control-agent, otherwise disabled               | Boolean. Forces the app into control-agent mode and connects to the control server automatically.              |
| `VITE_RALLAR_PROVIDER`              | No                                                               | `simulated`                                                          | Provider mode shortcut. `browser-rallar` enables real Rallar API usage; anything else falls back to simulated. |
| `VITE_RALLAR_PROVIDER_MODE`         | No                                                               | `simulated`                                                          | Same meaning as `VITE_RALLAR_PROVIDER`.                                                                        |
| `VITE_RALLAR_RUN_ID`                | No                                                               | `control-run-local` in control mode; `local-workbench-run` otherwise | Control run identifier.                                                                                        |
| `VITE_RALLAR_AGENT_ID`              | No                                                               | `visible-agent-local`                                                | Control agent identifier.                                                                                      |
| `VITE_RALLAR_CONTROL_TOKEN`         | No                                                               | None                                                                 | Optional run token sent to the control server. Public in the browser bundle if set through Vite.               |
| `VITE_RALLAR_HEARTBEAT_INTERVAL_MS` | No                                                               | Runtime default                                                      | Optional control-agent heartbeat interval.                                                                     |
| `VITE_RALLAR_STATS_INTERVAL_MS`     | No                                                               | Runtime default                                                      | Optional control-agent stats interval.                                                                         |
| `VITE_RALLAR_REPORT_UPLOAD_URL`     | No                                                               | None                                                                 | Optional final-report upload endpoint.                                                                         |
| `VITE_RALLAR_ENVIRONMENT`           | No                                                               | `local`                                                              | Label included in the black-box run config.                                                                    |
| `VITE_RALLAR_API_BASE_URL`          | Required for `browser-rallar` provider                           | `https://api.example.invalid`                                        | Rallar API base URL. The simulated provider can use the default.                                               |
| `VITE_RALLAR_APPLICATION_ID`        | No                                                               | `rallar-black-box`                                                   | Rallar application scope.                                                                                      |
| `VITE_RALLAR_WORKSPACE_ID`          | No                                                               | `default`                                                            | Rallar workspace scope.                                                                                        |
| `VITE_RALLAR_ACTOR`                 | No                                                               | `alice`                                                              | Actor/client label used in default runtime config.                                                             |
| `VITE_RALLAR_SESSION_ID`            | No                                                               | `visible-session-alice`                                              | Session ID used in default runtime config and restore flows.                                                   |
| `VITE_RALLAR_ROOM_ID`               | No                                                               | `rallar-black-box-room`                                              | Room/group ID used by browser-rallar flows.                                                                    |
| `VITE_RALLAR_TRANSPORT`             | No                                                               | `realtime`                                                           | Supported values in bootstrap: `realtime`, `messages.rtc`; anything else falls back to `realtime`.             |
| `VITE_RALLAR_USERNAME`              | Required for browser-rallar login unless restore-session is used | None                                                                 | Rallar login username. Public if bundled.                                                                      |
| `VITE_RALLAR_PASSWORD`              | Required for browser-rallar login unless restore-session is used | None                                                                 | Rallar login password. Public if bundled. Prefer local/test use only.                                          |
| `VITE_RALLAR_TOKEN`                 | Required for restore-session flows                               | None                                                                 | Access token for restored sessions. Public if bundled. Prefer local/test use only.                             |
| `VITE_RALLAR_REGISTER`              | No                                                               | Disabled                                                             | Boolean. Register before login when supported.                                                                 |
| `VITE_RALLAR_RESTORE_SESSION`       | No                                                               | Disabled unless a browser auth session already exists                | Boolean. Restore from supplied token/session values or local storage.                                          |
| `VITE_RALLAR_LOGOUT_ON_CLOSE`       | No                                                               | Disabled                                                             | Boolean. Log out on real-provider cleanup.                                                                     |
| `VITE_RALLAR_LEAVE_ROOM_ON_CLOSE`   | No                                                               | Enabled                                                              | Boolean. Leave room on real-provider cleanup.                                                                  |
| `VITE_RALLAR_AGENT_REGION`          | No                                                               | None                                                                 | Fleet label used by control-agent identity, fleet reports, and Fleet World Map fallback lookup.                |
| `VITE_RALLAR_AGENT_PROVIDER`        | No                                                               | None                                                                 | Fleet provider label used with region/datacenter summaries.                                                    |
| `VITE_RALLAR_AGENT_DATACENTER`      | No                                                               | None                                                                 | Fleet datacenter label. Known provider/datacenter pairs can resolve approximate map coordinates.               |
| `VITE_RALLAR_AGENT_LATITUDE`        | No                                                               | None                                                                 | Explicit fleet map latitude. Used only with a valid longitude; must be from `-90` to `90`.                     |
| `VITE_RALLAR_AGENT_LONGITUDE`       | No                                                               | None                                                                 | Explicit fleet map longitude. Used only with a valid latitude; must be from `-180` to `180`.                   |
| `VITE_RALLAR_AGENT_LOCATION_LABEL`  | No                                                               | None                                                                 | Human label for explicit fleet map coordinates.                                                                |
| `VITE_RALLAR_AGENT_TAGS`            | No                                                               | None                                                                 | Comma-separated fleet tags included in control-agent identity and reports.                                     |

The same fleet metadata can be supplied as URL query parameters in browser
bootstrap flows: `fleetRegion`, `fleetProvider`, `fleetDatacenter`,
`fleetLatitude`, `fleetLongitude`, `fleetLocationLabel`, and `fleetTags`.

### Rallar Black Box Headless Worker

`apps/rallar-black-box/src/headless-worker-config.ts` reads server-side
environment variables used by the headless browser worker script, then forwards
safe values to browser agents as URL parameters.

| Variable                                      | Required | Default | Usage                                                                                  |
| --------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `RALLAR_AGENT_REGION` / `RALLAR_BLACK_BOX_AGENT_REGION` | No | None | Fleet region label forwarded as `fleetRegion`.                                         |
| `RALLAR_AGENT_PROVIDER` / `RALLAR_BLACK_BOX_AGENT_PROVIDER` | No | None | Fleet provider label forwarded as `fleetProvider`.                                     |
| `RALLAR_AGENT_DATACENTER` / `RALLAR_BLACK_BOX_AGENT_DATACENTER` | No | None | Fleet datacenter label forwarded as `fleetDatacenter`.                                 |
| `RALLAR_AGENT_LATITUDE` / `RALLAR_BLACK_BOX_AGENT_LATITUDE` | No | None | Explicit fleet latitude forwarded as `fleetLatitude`; invalid values fail startup.      |
| `RALLAR_AGENT_LONGITUDE` / `RALLAR_BLACK_BOX_AGENT_LONGITUDE` | No | None | Explicit fleet longitude forwarded as `fleetLongitude`; invalid values fail startup.    |
| `RALLAR_AGENT_LOCATION_LABEL` / `RALLAR_BLACK_BOX_AGENT_LOCATION_LABEL` | No | None | Human label forwarded as `fleetLocationLabel`.                                         |
| `RALLAR_AGENT_TAGS` / `RALLAR_BLACK_BOX_AGENT_TAGS` | No | None | Comma-separated fleet tags forwarded as `fleetTags`.                                   |

### Full-Stack Playwright Startup

| Variable                      | Required | Default                 | Usage                                                                                                                                  |
| ----------------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_FULL_STACK` | No       | Disabled                | `1` or `true` enables API-v1 startup in `apps/rallar-black-box/playwright.full-stack.config.ts`.                                       |
| `RALLAR_BLACK_BOX_API_MODE`   | No       | `postgres`              | Full-stack API server mode. Supported values: `postgres`, `memory`. Memory mode starts API-v1 without env files or `DATABASE_URL`.     |
| `VITE_RALLAR_API_BASE_URL`    | No       | `http://localhost:8080` | Full-stack API base URL. The Playwright config derives API-v1 `PORT`, `RALLAR_API_BASE_URL`, and `RALLAR_WS_BASE_URL` from this value. |
| `VITE_RALLAR_SPA_BASE_URL`    | No       | `http://localhost:5176` | Full-stack SPA base URL. The Playwright config derives the Vite port and API CORS origins from this value.                             |

When `RALLAR_BLACK_BOX_API_MODE=memory`, the Playwright config starts API-v1
with:

- `RALLAR_SQL_BACKEND=pglite-memory`
- `RALLAR_PGLITE_DATA_DIR=memory://`
- `RALLAR_PGLITE_SCHEMA_INIT=auto`
- `RALLAR_DB_PUBSUB=local`
- `RALLAR_ICE_MODE=local`
- `RALLAR_LOGIN_USER_RATE_LIMIT=100`

### Rallar Black Box Playwright Test Inputs

These are read by tests under `tests/playwright/rallar-black-box`.

| Variable                                    | Required | Default                          | Usage                                                                       |
| ------------------------------------------- | -------- | -------------------------------- | --------------------------------------------------------------------------- |
| `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES`      | No       | Disabled                         | Boolean gate for live distributed recipe tests.                             |
| `RALLAR_BLACK_BOX_LIVE_DISTRIBUTED_RECIPES` | No       | Disabled                         | Alternate boolean gate for live distributed recipe tests.                   |
| `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX`          | No       | Disabled                         | Boolean gate for the live three-browser RTC matrix.                         |
| `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS`       | No       | Disabled                         | Boolean gate for exhaustive live RTC scenarios.                             |
| `VITE_RALLAR_GROUP_ID`                      | No       | None                             | Alias for `VITE_RALLAR_ROOM_ID` in the live RTC matrix.                     |
| `VITE_RALLAR_CLIENT_ID`                     | No       | Derived from username or default | Client ID for generic agent A full-stack helpers and restore-session smoke. |
| `VITE_RALLAR_EXPIRES_AT_EPOCH_MS`           | No       | Future test fallback             | Expiry timestamp for generic restored-session smoke.                        |
| `VITE_RALLAR_REAL_PEER_IDS`                 | No       | Empty                            | Comma-separated peer IDs for live real-provider direct or multicast sends.  |
| `VITE_RALLAR_MESSAGES_RTC_TYPE_ID`          | No       | Test default                     | Type ID for `messages.rtc` tests.                                           |
| `VITE_RALLAR_TYPE_ID`                       | No       | Test default                     | Fallback type ID for `messages.rtc` tests.                                  |
| `VITE_RALLAR_MESSAGES_RTC_TOPIC_ID`         | No       | Test default                     | Topic ID for `messages.rtc` tests.                                          |
| `VITE_RALLAR_TOPIC_ID`                      | No       | Test default                     | Fallback topic ID for `messages.rtc` tests.                                 |

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

## apps/rallar-black-box-control-server

This is a Deno control server. It does not load an env file by itself; set
variables in the shell or through the parent script/process.

| Variable                                        | Required | Default                           | Usage                                                                                                                                            |
| ----------------------------------------------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                          | No       | `5180`                            | HTTP and WebSocket listen port. Parsed with `Number(...)`.                                                                                       |
| `RALLAR_PRODUCTION_HARDENING`                   | No       | Disabled                          | `1`, `true`, `yes`, or `on` enables production startup validation for black-box control.                                                          |
| `RALLAR_BLACK_BOX_ALLOWED_COMMANDS`             | No       | All command kinds                 | Comma-separated allow-list of command kinds accepted by the control service.                                                                     |
| `RALLAR_BLACK_BOX_ALLOWED_ORIGINS`              | No       | No origin restriction             | Comma-separated request origins accepted by the general request policy.                                                                          |
| `RALLAR_BLACK_BOX_REQUIRE_TLS`                  | No       | Disabled                          | Boolean. Rejects non-HTTPS requests unless `x-forwarded-proto` is `https`.                                                                       |
| `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN`            | No       | Disabled                          | Boolean. Requires a valid run token for run/agent operations even when no token has been issued yet.                                             |
| `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN`           | No       | Disabled                          | Boolean. When enabled, run, fleet, distributed-run, and artifact GET routes require the same admin/operator authorization as mutations. `/health` and docs remain public. |
| `RALLAR_BLACK_BOX_ADMIN_TOKEN`                  | No       | None                              | Admin token for creating distributed runs and other admin operations. If unset, admin authorization is open for local use only. Prefer operator tokens plus optional break-glass admin token in production. |
| `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`        | No       | None                              | HMAC secret for accepting logged-in operator tokens issued by API-v1. Keep this equal to API-v1 `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`.        |
| `RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS`             | No       | `900000`                          | Default issued run-token TTL in milliseconds. Non-negative integer.                                                                              |
| `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES`            | No       | `2000000`                         | Max JSON request body size. Non-negative integer.                                                                                                |
| `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX`       | No       | `120`                             | Max accepted commands per rate-limit window. Non-negative integer.                                                                               |
| `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS` | No       | `60000`                           | Command rate-limit window in milliseconds. Non-negative integer.                                                                                 |
| `RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS`           | No       | No destination host restriction   | Comma-separated host allow-list for browser `http.request` commands. Supports exact host/hostname and `*.example.com` style suffixes.            |
| `RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS`         | No       | No destination origin restriction | Comma-separated origin allow-list for browser `http.request` commands.                                                                           |
| `RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS`             | No       | No destination host restriction   | Comma-separated host allow-list for browser `ws.open` commands. Supports exact host/hostname and `*.example.com` style suffixes.                 |
| `RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS`           | No       | No destination origin restriction | Comma-separated origin allow-list for browser `ws.open` commands.                                                                                |
| `RALLAR_BLACK_BOX_STORAGE_DIR`                  | No       | None                              | Directory for persisted `control-snapshot.json` and per-run artifact JSONL under `runs/`. If unset, control runs and artifact evidence are in-memory only. |
| `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`           | No       | `0`                               | Max retained runs for persistence/cleanup. `0` means no retention cap.                                                                           |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_COMMANDS`    | No       | `500`                             | Max recent command snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                    |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_RESULTS`     | No       | `500`                             | Max recent result snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                     |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_EVENTS`      | No       | `1000`                            | Max recent event snapshots persisted per run. Keeps high-volume RTC runs from forcing huge snapshot writes. Use `all`, `unbounded`, or `none` for no cap. |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_STATS`       | No       | `200`                             | Max recent stats snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                      |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_REPORTS`     | No       | `100`                             | Max recent report snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                     |
| `RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_HEARTBEATS`  | No       | `100`                             | Max recent heartbeat snapshots persisted per run. Use `all`, `unbounded`, or `none` for no cap.                                                  |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS`      | No       | `1000`                            | Max recent command envelopes retained in heap per run. Active distributed command links and pending commands are preserved. Use `all`, `unbounded`, or `none` for no cap. |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS`       | No       | `1000`                            | Max recent compact result envelopes retained in heap per run. Full result artifact rows are written to storage when `RALLAR_BLACK_BOX_STORAGE_DIR` is set. |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS`        | No       | `2000`                            | Max recent event envelopes retained in heap per run. Full event artifact rows are written to storage when `RALLAR_BLACK_BOX_STORAGE_DIR` is set. |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_STATS`         | No       | `500`                             | Max recent stats envelopes retained in heap per run. Use `all`, `unbounded`, or `none` for no cap.                                                |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS`       | No       | `20`                              | Max recent compact report envelopes retained in heap per run. Report `results` and `events` payloads are omitted server-side.                     |
| `RALLAR_BLACK_BOX_RUNTIME_RETAIN_HEARTBEATS`    | No       | `500`                             | Max recent heartbeat envelopes retained in heap per run. Use `all`, `unbounded`, or `none` for no cap.                                           |

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

| Variable                    | Required | Default                   | Usage                                                                                 |
| --------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `RALLAR_AI_LIVE_OLLAMA`     | No       | Disabled                  | `1`, `true`, `yes`, or `on` enables the live Ollama evaluation harness.               |
| `RALLAR_AI_OLLAMA_BASE_URL` | No       | `http://127.0.0.1:11434`  | Ollama sidecar base URL for live evaluation. Keep private to the server/test network. |
| `RALLAR_AI_OLLAMA_MODEL`    | No       | `llama-test` in the test  | Ollama model ID used by the live evaluation harness.                                  |
| `RALLAR_AI_LIVE_WEBLLM`     | No       | Disabled                  | Reserved gate for browser-run WebLLM live evaluation supplied by an application.      |

### Playwright

| Variable | Required | Default | Usage                                                                                                                                           |
| -------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`     | No       | Unset   | Root Playwright config forbids `.only`, enables 2 retries, switches reporter to HTML plus list, and disables `reuseExistingServer` when truthy. |

### Postgres Infrastructure

| Variable                      | Required                                      | Default                                                         | Usage                                                                                                                       |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`               | Container config                              | `app` in `docker-compose.yml`                                   | Postgres container user.                                                                                                    |
| `POSTGRES_PASSWORD`           | Container config                              | `app` in `docker-compose.yml`                                   | Postgres container password.                                                                                                |
| `POSTGRES_DB`                 | Container config                              | `appdb` in `docker-compose.yml`                                 | Postgres container database.                                                                                                |
| `RALLAR_POSTGRES_INTEGRATION` | No                                            | Disabled                                                        | `1` enables `packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts`; otherwise those tests are skipped. |
| `DATABASE_URL`                | Required when `RALLAR_POSTGRES_INTEGRATION=1` | Root script fallback: `postgres://app:app@localhost:5432/appdb` | Used by Postgres integration tests and worker fixtures. Also used by API-v1 as described above.                             |
| `RALLAR_EXPIRY_WORKER_INPUT`  | Worker-internal                               | None                                                            | JSON payload passed from the Postgres concurrency test to `fixtures/postgres-expiry-worker.ts`.                             |

### Shared Black-Box Runner

The shared black-box runner can resolve variables from arbitrary recipe
descriptors using `env` or `fromEnv`. The fixed variables below are used by
bundled live recipes, preflight checks, and remote-browser providers.

| Variable                            | Required                                                                       | Default                                                                                                     | Usage                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `RALLAR_API_BASE_URL`               | Required for live shared-runner Rallar API recipes                             | `https://api.example.com` in dry validation helpers; some preflight docs default to `http://localhost:8080` | Base URL for a live Rallar API service.                                  |
| `RALLAR_ROOM_ID`                    | Required by live browser validation helper                                     | `room-1` in dry validation helper                                                                           | Room/group ID used by live browser validation.                           |
| `RALLAR_ALICE_USERNAME`             | Required by live browser validation and many live recipes                      | `alice` in dry validation helper                                                                            | Alice test user.                                                         |
| `RALLAR_ALICE_PASSWORD`             | Required by live browser validation and many live recipes                      | `secret` in dry validation helper                                                                           | Alice test password. Treated as secret in redaction.                     |
| `RALLAR_BOB_USERNAME`               | Required by live browser validation and many live recipes                      | `bob` in dry validation helper                                                                              | Bob test user.                                                           |
| `RALLAR_BOB_PASSWORD`               | Required by live browser validation and many live recipes                      | `secret` in dry validation helper                                                                           | Bob test password. Treated as secret in redaction.                       |
| `RALLAR_MESSAGE_TYPE_ID`            | No                                                                             | `black-box.chat.message`                                                                                    | Message type ID for shared live browser validation.                      |
| `RALLAR_TOPIC_ID`                   | No                                                                             | `black-box.chat`                                                                                            | Topic ID for shared live browser validation.                             |
| `RALLAR_BLACK_BOX_CONTROL_BASE_URL` | Required for remote-browser-control provider and preflight; otherwise optional | `http://localhost:5180` in some preflight paths                                                             | Base URL for the black-box control server.                               |
| `RALLAR_BLACK_BOX_RUN_ID`           | No                                                                             | `remote-browser-run`                                                                                        | Run ID for the remote browser provider.                                  |
| `RALLAR_BLACK_BOX_AGENT_ID`         | Required by some remote-browser-control live recipes                           | Provider default when omitted                                                                               | Agent ID for the remote browser provider.                                |
| `RALLAR_BLACK_BOX_CONTROL_TOKEN`    | No                                                                             | None                                                                                                        | Control token used by the remote browser provider.                       |
| `RALLAR_BB_USERNAME`                | No                                                                             | None                                                                                                        | Generic fallback username for live preflight credential checks.          |
| `RALLAR_BB_PASSWORD`                | No                                                                             | None                                                                                                        | Generic fallback password for live preflight credential checks.          |
| `RALLAR_BB_PREFLIGHT_GROUP_ID`      | No                                                                             | `bb-live-preflight`                                                                                         | Group ID used by live preflight.                                         |
| `RALLAR_BB_GROUP_ID`                | No                                                                             | `bb-live-preflight` fallback                                                                                | Recipe/preflight group ID variable.                                      |
| `RALLAR_BB_SOAK_GROUP_ID`           | No                                                                             | `bb-live-preflight` fallback                                                                                | Soak recipe/preflight group ID variable.                                 |
| `RALLAR_BB_APPLICATION_ID`          | No                                                                             | `black-box-app`                                                                                             | Application ID used by live preflight group setup.                       |
| `RALLAR_BB_WORKSPACE_ID`            | No                                                                             | `default`                                                                                                   | Workspace ID used by live preflight group setup.                         |
| `RALLAR_BB_GROUP_NAME`              | No                                                                             | Group ID                                                                                                    | Group display name used by live preflight group setup.                   |
| `RALLAR_PREFLIGHT_CORS_ORIGIN`      | No                                                                             | None                                                                                                        | CORS origin used by shared-runner live preflight checks when configured. |
