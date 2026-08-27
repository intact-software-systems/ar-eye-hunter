# Production Environment Hardening Checklist

API-v1 and Relic hardening belong to the immutable API-v1 configuration
snapshot. Select it with the exact value
`RALLAR_API_CONFIGURATION_PROFILE=prod`; there is no environment-name alias or
second hardening validator. The black-box control server is a separate process
and owns its explicit `RALLAR_PRODUCTION_HARDENING=1` check.

Configuration is restart-only. A changed profile, override, or secret affects a
process only after restart or redeployment. Startup errors identify variable
names and configuration paths without reporting secret values.

## API-v1 Production

- Set `RALLAR_API_CONFIGURATION_PROFILE=prod`.
- Keep the profile-owned PostgreSQL, PostgreSQL pub/sub, strict read auth,
  admin-only registration, disabled static clients, Metered ICE, HTTPS/WSS
  public URLs, and exact HTTPS CORS settings unless the deployment has a real
  target-specific override.
- Set visible deployment values for `AUTH_ADMIN_CLIENT_IDS`,
  `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`, and `METERED_APP_NAME`. Administrator
  identities must be non-demo identities.
- Keep the Deno Deploy-provided `DATABASE_URL` available to the application at
  runtime. Store `RALLAR_AUTH_CREDENTIAL_SECRET`, `METERED_API_KEY`, and
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` as platform secrets. The auth secret
  must contain at least 32 characters and remain stable while sessions,
  tickets, or durable AppInbox results can be replayed.
- Configure optional non-secret overrides only from the allowlist in
  [Environment Variables](./environment-variables.md). Do not set
  `ENVIRONMENT`, unprefixed server `API_BASE_URL`, or removed formation and
  dissemination settings.

The Deno Deploy preflight reads redacted environment metadata for
`rallar-server` and refuses deployment unless the production context contains
the exact `prod` selector, required visible values, and the three
repository-managed platform secret names. Deno Deploy guarantees
`DATABASE_URL`, so the preflight does not require it to appear in the redacted
metadata. The preflight never prints or uploads the environment document.

## Relic Server Production

- Apply the complete API-v1 production checklist to the embedded server.
- Set `RELIC_REST_AUTH_MODE=group-policy` in the production context.
- Keep `RELIC_AI_EXPEDITION_OLLAMA_BASE_URL` private when
  `RELIC_AI_EXPEDITION_MODE=ollama`.
- Snapshot reads require full group read permission, commands require room send
  permission, and reset requires active owner/admin permission.

The Deno Deploy preflight applies the same API-v1 evidence checks to
`relic-hunters` and additionally requires the exact Relic group-policy value.

## Hetzner Disposable Controller

The controller VM is intentionally ephemeral and selects
`RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory`. Its deployment and rollout
scripts write only the controller-owned override subset, preserve stable auth
and operator secrets, remove unrecognized or obsolete entries, and install
`/etc/rallar/api-v1.env` as root-owned mode `0600`. Restarting API-v1 loses
in-memory sessions and runtime state.

## Black-Box Control Production

- Set `RALLAR_PRODUCTION_HARDENING=1`.
- Set exact HTTPS `RALLAR_BLACK_BOX_ALLOWED_ORIGINS` and
  `RALLAR_BLACK_BOX_REQUIRE_TLS=1`.
- Set `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1` and
  `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN=1`.
- Store `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` as a platform secret equal to
  the API-v1 issuer secret. An optional admin token is break-glass only.
- Restrict HTTP and WebSocket command destinations with their host or origin
  allowlists.
- Set `RALLAR_BLACK_BOX_STORAGE_DIR` and a positive
  `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`.

## Secret Hygiene

- Keep deployment secret files root-owned and mode `0600`.
- Keep local `.env` files ignored and outside static browser builds.
- Prefer bearer headers over query tokens.
- Treat `VITE_*`, `API_*`, browser URLs, local storage, and SPA audit files as
  public.
- Do not print, upload, or place secret-store exports in workflow artifacts.
