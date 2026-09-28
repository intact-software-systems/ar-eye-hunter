# Rallar API-v1 In-Memory Performance Mode

Use the `prod-in-memory` profile for a single API-v1 process that supports
Rallar middleware, browser-fleet validation, and disposable performance runs
without PostgreSQL.

The profile owns PGlite memory storage, automatic schema initialization, local
queue pub/sub, local ICE, strict state-read authorization, demo clients, public
registration, and black-box operator brokerage. Data, auth sessions, and
runtime state disappear when the process restarts.

## Start

From `apps/api-v1`:

```sh
deno task start:memory
```

The task sets only:

```text
RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory
```

The profile still needs two environment-only secrets, because it enables
operator-token issue: `RALLAR_AUTH_CREDENTIAL_SECRET` (at least 32 characters)
and `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`. API-v1 also loads `.env` from the
working directory. Startup fails with a configuration error when either secret
is missing, or when `METERED_API_KEY` is set, because the profile uses local
ICE.

The profile's committed public URLs and CORS origins belong to the hosted
deployment. For a local run, override them:

```sh
PORT=18080 \
RALLAR_API_BASE_URL=http://127.0.0.1:18080 \
RALLAR_WS_BASE_URL=ws://127.0.0.1:18080 \
CORS_ORIGINS=http://localhost:5176,http://127.0.0.1:5176 \
deno task start:memory
```

From the repository root, `npm run start:rallar:api:memory` starts the same
profile with the Black Box SPA CORS origins set. It does not override the
public URLs.

The server logs one JSON startup summary before opening the database. Its safe
shape includes `profile: "prod-in-memory"`, `databaseMode: "pglite-memory"`,
`databasePubSub: "local"`, `iceMode: "local"`, public URLs, CORS origins,
worker categories, and the names of explicit non-secret overrides. It does not
include secret values, secret lengths, or database credentials.

## Black-Box Validation

Run the managed API-v1 memory recipe matrix:

```sh
npm run test:api-v1:black-box:memory
```

Run the API-backed Rallar Black Box browser suite:

```sh
npm run test:rallar:full-stack:memory
```

Run the gated three-browser RTC baseline:

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
```

The managed black-box runner selects `prod-in-memory` itself, injects bounded
fixture credentials, and applies only backend, endpoint, recipe, and workload
overrides to each child API process. The child is spawned without clearing the
environment, so variables exported in the parent shell and a repository-root
`.env` still reach it.

Detailed browser coverage and artifact notes live in
[API-v1 memory-mode validation](../apps/rallar-black-box/docs/api-v1-memory-mode-validation.md).

## Limits

- Use one API-v1 process with local pub/sub. Multi-node validation requires
  PostgreSQL and PostgreSQL pub/sub overrides managed by the black-box runner.
- Do not use this profile as durable production storage.
- Configuration is restart-only. Change the selector or an override, then
  restart the process.
- Use the `prod` profile for public API-v1 and Relic deployments, or
  `prod-hardened` for admin-only registration, disabled demo clients, and
  enforced production hardening.
