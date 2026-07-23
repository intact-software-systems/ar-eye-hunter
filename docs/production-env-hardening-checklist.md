# Production Env Hardening Checklist

This checklist is for production API-v1, Relic server, and black-box control
deployments. The runtime guardrail is enabled by either
`RALLAR_PRODUCTION_HARDENING=1` or `ENVIRONMENT=prod` / `ENVIRONMENT=production`.
When enabled, startup fails with variable-name errors and never logs secret
values.

## Local/Demo Vs Production

| Surface | Local/demo default | Hardened production |
| --- | --- | --- |
| API-v1 storage | PGlite memory/file modes are allowed. | `RALLAR_SQL_BACKEND=postgres` and `DATABASE_URL` are required. |
| API-v1 CORS | Localhost defaults or `*` may be used for dev. | `CORS_ORIGINS` must list exact HTTPS SPA origins; no wildcard or localhost. |
| API-v1 registration | `AUTH_REGISTRATION_MODE=public`. | `AUTH_REGISTRATION_MODE=admin`. |
| API-v1 demo users | `AUTH_STATIC_CLIENTS_MODE=demo` keeps bundled `admin`, `user`, `guest`, and test users. | `AUTH_STATIC_CLIENTS_MODE=disabled`; provision real runtime users. |
| API-v1 state reads | `/api/state/*` is authenticated; strict full-state read policy is opt-in. | `RALLAR_STATE_STRICT_READ_AUTH=1`. |
| TURN/ICE | `RALLAR_ICE_MODE=local` may return no ICE servers. | `RALLAR_ICE_MODE=metered`, `METERED_APP_NAME`, and `METERED_API_KEY`. |
| Relic REST | `RELIC_REST_AUTH_MODE=authenticated` requires login only. | `RELIC_REST_AUTH_MODE=group-policy`. |
| Black-box control CORS | Empty allow-list means no origin restriction. | `RALLAR_BLACK_BOX_ALLOWED_ORIGINS` must list exact HTTPS SPA origins. |
| Black-box admin/operator auth | Missing admin/operator tokens leave mutation auth open for local use. | `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` is required; optional admin token is break-glass only. |
| Black-box run/read tokens | Run and read tokens are optional. | `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1` and `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN=1`. |
| Black-box artifacts | In-memory snapshots and unbounded retention are allowed. | `RALLAR_BLACK_BOX_STORAGE_DIR` and positive `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`. |
| Browser env | Only `VITE_*` is intentionally public in Vite bundles. | Never put server secrets in `VITE_*`, `API_*`, URLs, or browser-visible audit files. |

## API-v1 Production

- Set `RALLAR_PRODUCTION_HARDENING=1` or `ENVIRONMENT=prod`.
- Set `RALLAR_SQL_BACKEND=postgres` and `DATABASE_URL=<secret>`.
- Set `CORS_ORIGINS=<exact https SPA origins>`; do not use `*`, localhost, or an empty list.
- Set `RALLAR_STATE_STRICT_READ_AUTH=1`.
- Set `AUTH_REGISTRATION_MODE=admin`.
- Set `AUTH_ADMIN_CLIENT_IDS=<runtime admin client ids>`; do not use the default `admin`.
- Set `AUTH_STATIC_CLIENTS_MODE=disabled`.
- Set `RALLAR_AUTH_CREDENTIAL_SECRET=<stable high-entropy secret>` with at least 32 characters. Rotating it invalidates reconstruction of outstanding AppInbox auth results and tickets.
- Set `RALLAR_ICE_MODE=metered`, `METERED_APP_NAME=<secret-ish id>`, `METERED_API_KEY=<secret>`, and optional `METERED_REGION`.
- If black-box operator tokens are brokered through API-v1, set `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=<shared high-entropy secret>`, `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=<allowlist>`, and explicit `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`.

## Relic Server Production

- Set the same inherited API-v1 database, auth, CORS, TURN, and operator-token values.
- Set `RELIC_REST_AUTH_MODE=group-policy`.
- Keep `RELIC_AI_EXPEDITION_OLLAMA_BASE_URL` private when `RELIC_AI_EXPEDITION_MODE=ollama`.
- In group-policy mode, snapshot reads require full group read permission, commands require room send permission, and reset requires active owner/admin permission.

## Black-Box Control Production

- Set `RALLAR_PRODUCTION_HARDENING=1`.
- Set `RALLAR_BLACK_BOX_ALLOWED_ORIGINS=<exact https SPA origins>`; do not use wildcard origins.
- Set `RALLAR_BLACK_BOX_REQUIRE_TLS=1`.
- Set `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1`.
- Set `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN=1`.
- Set `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` to the same value used by API-v1.
- Optional break-glass: set `RALLAR_BLACK_BOX_ADMIN_TOKEN=<high-entropy secret>`.
- Restrict browser command egress with at least one HTTP allow-list and one WebSocket allow-list: `RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS` or `RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS`, plus `RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS` or `RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS`.
- Set `RALLAR_BLACK_BOX_STORAGE_DIR` and positive `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`.

## Secret Hygiene

- Keep deploy secret files mode `0600`.
- Keep local `.env` files ignored and never copy them into static browser builds.
- Prefer bearer headers over query `token=` for operator, admin, and run tokens.
- Treat `VITE_*`, `API_*`, static SPA audit files, browser URLs, and browser local storage as public.
- `apps/rallar-black-box` now exposes only `VITE_*` variables to the browser bundle; server-only `RALLAR_*` names must stay on servers, workers, or deployment scripts.
