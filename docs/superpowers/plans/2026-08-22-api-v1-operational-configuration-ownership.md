# API-v1 Operational Configuration Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every API-v1 operational setting once into one immutable, app-owned configuration snapshot, pass explicit policy and lifecycle dependencies through API-v1 and the embedded Relic server, and delete all superseded readers, aliases, database globals, and selectable legacy group behavior.

**Architecture:** `apps/api-v1/src/configuration/` is the only owner of API-v1 profile resources, environment translation, secret acquisition, strict decoding, cross-field validation, redaction, and public projection. `main.ts` resolves the snapshot before side effects; one explicit database lifecycle creates and closes SQL and notification resources; composition passes coherent required sections to routes, services, workers, and the Relic embedding boundary. No lower layer reads process environment or selects an operational default.

**Tech Stack:** Deno and TypeScript with `erasableSyntaxOnly`, Hono, PostgreSQL/postgres.js, PGlite, Vitest, JSON profile resources, shell and GitHub workflow validation, and Rallar black-box recipes.

**Spec:** [`docs/superpowers/specs/2026-08-22-api-v1-operational-configuration-ownership-design.md`](../specs/2026-08-22-api-v1-operational-configuration-ownership-design.md)

## Global Constraints

- After this design/plan PR merges, create a fresh worktree from current `main` on `codex/api-v1-operational-configuration-ownership`. Never edit, commit, or push the default branch.
- Follow `.agents/skills/rallar-code-writing/references/repo-code-style.md`, `.agents/skills/rallar-code-writing/references/typescript-type-organization.md`, and `.agents/skills/rallar-code-writing/references/convergent-service-writing.md` for every TypeScript file.
- Follow touched-file standards closure. Review every changed human-authored file in full; recursively include support files changed to repair violations.
- Do not introduce aliases, deprecated exports, forwarders, overloads, duplicate resources, fallback readers, compatibility JSON, dual reads, or legacy registries. Delete superseded code in the same task that migrates its final consumer.
- Preserve public REST, WebSocket, RTC, CRDT, AppInbox, persistence, and outbox contracts except for the explicitly approved deletion of configuration-selected group legacy behavior.
- Preserve AppInbox reservation, retry, idempotency, receipt, transaction, and outbox behavior.
- Keep Prisma's `DATABASE_URL` read in `apps/api-v1/prisma.config.ts`; Prisma is a separate tool process boundary.
- Keep black-box recipe input names such as `RALLAR_API_BASE_URL` where they describe the runner's target URL. Remove only the obsolete server-side alias `API_BASE_URL`.
- Keep persisted formation fact fields required by the existing durable format, but constrain their type and value to the single literal `'damped'`. This is persisted-shape preservation, not a selectable compatibility path.
- Make operational configuration fields mandatory unless absence itself is a discriminated domain state. Consumers never apply fallback defaults.
- Keep server-generated IDs, clocks, fetch implementations, SQL clients, repositories, and lifecycle objects out of the configuration snapshot.
- Never print supplied configuration values in decoding errors. Never print secret values, lengths, fingerprints, credential-bearing URLs, source objects, or environment dumps.
- Every retained test must name an independent production break, exercise the lowest stable owned boundary, and derive expectations independently of production decoders/builders. Assert interaction counts or order only for required lifecycle, idempotency, cache, retry, or exactly-once effects.
- Use direct imports. Never use backslash line continuations in import specifiers; allow an import line to remain long when required.
- Open one draft implementation PR after the first coherent implementation commit. After each task, run its focused checks, review `git diff --check`, commit one reviewable slice, and push so that implementation PR remains current.
- Slices 1 and 2 are the only concrete current implementation horizon. Slices 3-5 record required outcome owners and acceptance evidence; after the first two slices, select and refine only the next one or two useful slices from current source evidence without weakening the approved outcomes.
- The delayed formation-timer queue wake race is independent. Do not change configuration defaults, add sleeps, or weaken black-box assertions to hide it. Classify a matching failure with the existing issue evidence.

## Required Target Structure

```text
apps/api-v1/src/configuration/
  README.md
  api-v1-configuration.ts
  api-v1-configuration-error.ts
  decode-api-v1-configuration.ts
  read-api-v1-configuration.ts
  to-api-v1-public-configuration.ts

apps/api-v1/resources/configuration/
  defaults-config.json
  dev-config.json
  prod-config.json
  prod-in-memory-config.json

apps/api-v1/src/db/
  api-v1-database-lifecycle.ts
```

There is no configuration barrel. Consumers import the direct owner. Consolidate helpers when they share callers and one reason to change; split only along contract, source translation, error/redaction, public projection, or lifecycle boundaries.

Before implementation edits, restate that one resolved configuration snapshot remains the requested outcome and name both immediate validations: the focused configuration decoder/construction tests and `cd apps/api-v1 && deno task check`. At each horizon checkpoint, update the active working plan rather than treating this durable document as a live status database.

## Configuration Contract Ledger

The implementation must encode every row as a required typed section and reconcile it against the previous reader before deleting that reader.

| Section | Required policy |
|---|---|
| `profile` | exact `dev | prod | prod-in-memory`, effective production hardening, sorted applied override names |
| `http` | port, CORS origins, preflight max age, process/listener resilience policy |
| `publicApi` | normalized HTTP(S) API base URL and WS(S) base URL; endpoint paths remain code-owned |
| `database` | discriminated PostgreSQL, PGlite file, or PGlite memory mode; schema bootstrap; pub/sub; application/listener pool policy |
| `authentication` | registration mode, static-client mode and loaded records, admin client IDs, credential secret, session/ticket lifetimes, login/registration/ticket rate limits |
| `stateApi` | strict read authorization, request/event-list rate limits, circuit-breaker threshold and durations |
| `group` | default member cap and join/presence admission windows and limits |
| `topology` | planning limits, RTT reporting/refinement, debounce policies, global recompute limits, replay mode, queue-worker mode, QueueBox resilience, delivery policy |
| `appInbox` | phase timing and completion wait policy; reservation doctrine remains code-owned |
| `ice` | discriminated local or Metered provider, cache lifetime, request rate limit; Metered credentials only in Metered mode |
| `crdt` | canonical document-type rollout policies |
| `blackBox` | explicit operator-token issuer policy and PGlite evidence publication policy |
| `observability` | timing-log policy and safe startup-summary policy |

Carry forward these current defaults in `defaults-config.json` unless source inspection proves that current `main` intentionally changed them before implementation:

- HTTP port `8080`, local CORS origins `http://localhost:5173` through `http://localhost:5176`, preflight `600` seconds.
- PostgreSQL application pool `max=5`, `idleTimeoutSeconds=20`; dedicated listener pool `max=1`, `idleTimeoutSeconds=0`.
- Auth session TTL `2_592_000_000` ms, WS ticket TTL `30_000` ms, agent ticket TTL `60_000` ms.
- Auth rate-limit window `60_000` ms with login IP `30`, login username `5`, registration IP `20`, registration username `5`, and WS-ticket `30`.
- State rate-limit window `60_000` ms with general request limit `300`, event-list limit `60`, and circuit threshold `10` with `10_000` ms open/reset/sampling durations.
- Group member cap `256`; admission window `60_000` ms with join principal/group `60/600` and presence principal/group `120/1200`.
- AppInbox wait max `30_000` ms, initial retry `250` ms, max retry `1_000` ms, jitter ratio `0.1`, phase timing disabled, timing logs enabled.
- ICE window `60_000` ms, request limit `20`, and cache TTL `300_000` ms.
- Queue resilience retains the current threshold/duration/rate/fairness values owned by the existing `toResilienceDto` path.
- Topology and CRDT defaults are copied exactly from their current canonical code constants into the JSON resource, then the old fallback-bearing readers are deleted.

## Source and Profile Rules

Apply sources once in this exact order:

```text
defaults-config.json
  -> selected profile JSON
  -> explicitly mapped environment overrides
  -> environment-only secrets
  -> exact decoding and cross-field validation
  -> deep immutable snapshot
```

The selector is only `RALLAR_API_CONFIGURATION_PROFILE`; absence means `dev`, and accepted values are exactly case-sensitive `dev`, `prod`, and `prod-in-memory` with surrounding whitespace rejected. `RALLAR_PRODUCTION_HARDENING=1` may promote another profile; nothing disables hardening for `prod`.

The central allowlist contains exactly the environment names in the approved spec. Generic environment iteration, dotted paths, arbitrary merging, and JSON-in-one-variable configuration are forbidden. Secret names are `DATABASE_URL`, `RALLAR_AUTH_CREDENTIAL_SECRET`, `METERED_API_KEY`, and `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`; committed JSON must never contain their values.

---

## Slice 1: Build and prove the pure configuration owner

### Task 1: Define the complete contract and exact profile resources

**Files:**

- Create: `apps/api-v1/src/configuration/api-v1-configuration.ts`
- Create: `apps/api-v1/src/configuration/api-v1-configuration-error.ts`
- Create: `apps/api-v1/src/configuration/decode-api-v1-configuration.ts`
- Create: `apps/api-v1/src/configuration/README.md`
- Create: `apps/api-v1/resources/configuration/defaults-config.json`
- Create: `apps/api-v1/resources/configuration/dev-config.json`
- Create: `apps/api-v1/resources/configuration/prod-config.json`
- Create: `apps/api-v1/resources/configuration/prod-in-memory-config.json`
- Create: `apps/api-v1/test/configuration/api-v1-configuration-test-fixture.ts`
- Create: `apps/api-v1/test/configuration/decode-api-v1-configuration.test.ts`

- [ ] Add decoder tests first for exact top-level and nested keys, missing required fields, wrong types, non-finite/unsafe numbers, URLs, origins, enums, duplicate set-like values, ordered arrays, malformed CRDT policies, and every database/pub-sub/ICE/replay/worker contradiction.
- [ ] Add one table-driven test proving valid and invalid boundaries for every integer and ratio policy. Assert malformed topology values produce issues instead of disappearing into defaults.
- [ ] Add aggregate-failure tests with at least one independent issue from defaults, profile, environment, secret, and invariant sources. Assert deterministic source/path ordering.
- [ ] Add secret-safety tests using unique sentinel values for all four secrets and assert none appears in `error.message`, issue messages, JSON serialization, or safe rendering.
- [ ] Run `cd apps/api-v1 && deno task test test/configuration/decode-api-v1-configuration.test.ts`. Confirm RED because the owner modules do not exist.
- [ ] Define `ApiV1Configuration` with named nested sections and database/ICE discriminated unions. Do not export shorten-only aliases. Keep every field `readonly`.
- [ ] Define `ApiV1ConfigurationIssue` with `source`, `path`, optional `environmentName`, stable `code`, and safe `message`. `ApiV1ConfigurationError` owns a sorted immutable issue list and renders only safe metadata.
- [ ] Implement exact-object decoding with a collector that records independently detectable issues. Decode source shapes separately from the final required contract so sparse profile overlays cannot escape into consumers.
- [ ] Encode database invariants: PostgreSQL alone accepts PostgreSQL pub/sub and requires URL plus both pool policies; PGlite file requires a non-memory path; PGlite memory uses `memory://`; PGlite modes allow only local/disabled pub/sub and the selected bootstrap/evidence settings.
- [ ] Encode ICE invariants: Metered requires app name, API key, and region; local mode rejects those fields.
- [ ] Encode hardening invariants against the effective snapshot: PostgreSQL, PostgreSQL pub/sub, HTTPS/WSS, exact secure origins, strict reads, admin-only registration, non-demo admins, disabled static clients, stable auth secret, Metered ICE, and explicit operator-token issuer.
- [ ] Populate the four JSON resources from the ledger and current source constants. `dev` selects PGlite memory/local delivery/local ICE/public registration/demo clients; `prod` selects PostgreSQL/PostgreSQL delivery/Metered/admin-only/strict reads; `prod-in-memory` uses hosted production-facing URLs with PGlite memory/local delivery.
- [ ] Document ownership, precedence, direct-import rule, restart-only updates, secret rules, and the complete allowlist in `configuration/README.md`.
- [ ] Run the focused test until GREEN, then run `cd apps/api-v1 && deno fmt --check src/configuration test/configuration resources/configuration && deno lint src/configuration test/configuration`.
- [ ] Review every new file against the type-organization and touched-file standards. Run `git diff --check`.
- [ ] Commit with `git add apps/api-v1/src/configuration apps/api-v1/resources/configuration apps/api-v1/test/configuration && git commit -m "feat(api-v1): define operational configuration contract"`, then `git push`.

The final public shape begins with this ownership boundary; field names may be regrouped only when review finds one policy split across owners:

```ts
export interface ApiV1Configuration {
    readonly profile: ApiV1Configuration.Profile;
    readonly http: ApiV1Configuration.Http;
    readonly publicApi: ApiV1Configuration.PublicApi;
    readonly database: ApiV1Configuration.Database;
    readonly authentication: ApiV1Configuration.Authentication;
    readonly stateApi: ApiV1Configuration.StateApi;
    readonly group: ApiV1Configuration.Group;
    readonly topology: ApiV1Configuration.Topology;
    readonly appInbox: ApiV1Configuration.AppInbox;
    readonly ice: ApiV1Configuration.Ice;
    readonly crdt: ApiV1Configuration.Crdt;
    readonly blackBox: ApiV1Configuration.BlackBox;
    readonly observability: ApiV1Configuration.Observability;
}
```

### Task 2: Resolve sources once, freeze the snapshot, and project only public data

**Files:**

- Create: `apps/api-v1/src/configuration/read-api-v1-configuration.ts`
- Create: `apps/api-v1/src/configuration/to-api-v1-public-configuration.ts`
- Create: `apps/api-v1/test/configuration/read-api-v1-configuration.test.ts`
- Create: `apps/api-v1/test/configuration/to-api-v1-public-configuration.test.ts`
- Modify: `apps/api-v1/test/configuration/api-v1-configuration-test-fixture.ts`
- Read for exact public contract: `packages/shared/api/api-config.ts`
- Read for static-client shape: `apps/api-v1/resources/authorised-clients.json`

- [ ] Write source tests first for absent and exact profile selectors; reject `ENVIRONMENT`, `production`, wrong case, empty selector, and surrounding whitespace.
- [ ] Test leaf precedence independently: defaults < profile < allowlisted environment < secret. Prove an unrelated environment name is ignored and an explicit invalid value never falls back.
- [ ] Test static demo-client loading once, production disablement, set canonicalization, ordered-array preservation, and isolation from source mutation after resolution.
- [ ] Test the returned object recursively with `Object.isFrozen`, including arrays and nested records.
- [ ] Test the safe startup summary for profile, hardening, database/pub-sub/ICE modes, public URLs/origins, queue-worker categories, and sorted override names. Assert sentinel secrets, lengths, fingerprints, and credential-bearing database URLs are absent.
- [ ] Test `toApiV1PublicConfiguration` returns exactly the existing browser-owned `ApiConfig` fields and cannot accept a secret-bearing type. Keep endpoint paths code-owned.
- [ ] Run both focused test files and confirm RED because source resolution and projection are absent.
- [ ] Implement explicit test ports for resource text and named environment reads. Production resource URLs are passed from `main.ts`; the reader does not discover filesystem layout from a working directory.
- [ ] Map only the approved environment allowlist to explicit leaf paths. Collect applied override names while never walking or serializing the full environment.
- [ ] Load secrets through separately named mappings so errors can mention only canonical environment names and configuration paths.
- [ ] Apply sparse overlays with explicit per-section/per-leaf functions; do not use recursive generic object merge.
- [ ] Decode once, deeply freeze once, and return the same snapshot to every consumer. Implement the safe summary and public projection as narrow outputs that cannot enumerate the whole configuration object.
- [ ] Run `cd apps/api-v1 && deno task test test/configuration/read-api-v1-configuration.test.ts test/configuration/to-api-v1-public-configuration.test.ts` until GREEN.
- [ ] Run the full configuration directory tests, `deno check src/configuration/read-api-v1-configuration.ts`, `deno lint src/configuration test/configuration`, and `git diff --check`.
- [ ] Commit with `git add apps/api-v1/src/configuration apps/api-v1/test/configuration && git commit -m "feat(api-v1): resolve one immutable configuration snapshot"`, then `git push`.

### Slice 1 checkpoint

- [ ] Re-run `rg -n "Deno\\.env|getEnv\\(|readEnv|ENVIRONMENT|RALLAR_GROUP_FORMATION_DAMPING|RALLAR_GROUP_STATE_DISSEMINATION|API_BASE_URL" apps/api-v1 apps/relic-hunter-server-v1 packages/shared-server .github scripts docs --glob '!docs/superpowers/**'`.
- [ ] Reconcile every API-v1 operational read with the contract ledger. Add any legitimate deployer policy missing from the JSON defaults before runtime migration; do not create an environment override without deployment evidence.
- [ ] Inspect current task 3 and task 4 targets and update file lists if ownership moved on `main`.

---

## Slice 2: Establish explicit database and server construction lifecycles

### Task 3: Replace SQL, LISTEN, and NOTIFY globals with one database lifecycle

**Files:**

- Create: `apps/api-v1/src/db/api-v1-database-lifecycle.ts`
- Create: `apps/api-v1/test/db/api-v1-database-lifecycle.test.ts`
- Modify: `apps/api-v1/src/db/api-v1-queue-pubsub-bridge.ts`
- Modify: `apps/api-v1/src/db/postgres-queue-pubsub-bridge.ts`
- Modify: `apps/api-v1/src/db/api-v1-rtc-topology-cluster-transport.ts`
- Modify: `apps/api-v1/src/db/in-memory-schema-bootstrap.ts`
- Modify: `apps/api-v1/src/db/pglite-black-box-evidence-snapshot.ts`
- Modify: `apps/api-v1/src/db/pglite-sql-adapter.ts`
- Modify: `apps/api-v1/test/db/postgres-queue-pubsub-bridge.test.ts`
- Modify: `apps/api-v1/test/db/local-queue-pubsub-bridge.test.ts`
- Modify: `apps/api-v1/test/db/managed-pglite-lifecycle.test.ts`
- Delete after final consumer migration: `apps/api-v1/src/db/database-config.ts`
- Delete after final consumer migration: `apps/api-v1/src/db/database-pubsub-config.ts`
- Delete after final consumer migration: `apps/api-v1/src/db/db-listen.ts`
- Delete after final consumer migration: `apps/api-v1/src/db/db-notify.ts`
- Delete after final consumer migration: `apps/api-v1/src/db/db.ts`
- Delete after replacement: `apps/api-v1/test/db/database-config.test.ts`
- Delete after replacement: `apps/api-v1/test/db/database-pubsub-config.test.ts`

- [ ] Write lifecycle tests first for PGlite memory, PGlite file, and PostgreSQL. Capture constructor inputs and assert exact application/listener pool policies, readiness ordering, bootstrap/evidence behavior, and close-once idempotence.
- [ ] Test partial-construction failure: if listener, bootstrap, or evidence setup fails, every previously created resource closes exactly once and no port escapes.
- [ ] Test explicit notification behavior: PostgreSQL creates a port with `notify` and `listen`; local/disabled modes never create a PostgreSQL listener. Assert subscription payload delivery without any import-time SQL lookup.
- [ ] Change bridge tests to require the notification port explicitly. Confirm RED when constructors still default to `db-listen.ts` or `db-notify.ts`.
- [ ] Implement one `ApiV1DatabaseLifecycle` owner returning normalized `PSqlSql`, optional mode-specific notification capability, readiness, and idempotent `close()`:

```ts
export interface ApiV1DatabaseLifecycle {
    readonly database: PSqlSql;
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly readiness: Promise<void>;
    close(): Promise<void>;
}

export interface ApiV1DatabaseNotificationPort {
    notify(channel: string, message: unknown): Promise<void>;
    listen(channel: string, onMessage: (payload: string) => void | Promise<void>): Promise<void>;
}
```

- [ ] Keep PostgreSQL URL normalization as one pure translation in the lifecycle module or a single directly owned helper. Never render the URL.
- [ ] Make `createPostgresQueuePubSubBridge` and the topology cluster transport require the notification port. Make the local bridge selection receive resolved mode instead of reading it.
- [ ] Migrate all test fixtures that imported `sql`, `getSql`, or default bridge/listener behavior to construct a lifecycle or pass an explicit SQL/notification fake.
- [ ] Use `rg -n "getSql|createApiV1SqlClient|getListenSql|startListening|from './db-notify|from './db-listen|\\bsql\\b" apps/api-v1/src apps/api-v1/test` to locate the final consumers. Do not delete the old modules until this search shows no required import.
- [ ] Delete the five global/config modules and their obsolete tests in the same commit. Do not leave forwarders.
- [ ] Run `cd apps/api-v1 && deno task test test/db/api-v1-database-lifecycle.test.ts test/db/postgres-queue-pubsub-bridge.test.ts test/db/local-queue-pubsub-bridge.test.ts test/db/managed-pglite-lifecycle.test.ts` until GREEN.
- [ ] Run the affected PGlite tests, `deno check src/db/api-v1-database-lifecycle.ts`, `deno lint src/db test/db`, and `git diff --check`.
- [ ] Commit the complete boundary with `git add -A apps/api-v1/src/db apps/api-v1/test/db && git commit -m "refactor(api-v1): own database lifecycle explicitly"`, then `git push`.

### Task 4: Resolve configuration before side effects and require it in server composition

**Files:**

- Modify: `apps/api-v1/src/main.ts`
- Modify: `apps/api-v1/src/composition/create-default-rallar-server.ts`
- Modify: `apps/api-v1/src/composition/create-rallar-server.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-runtime.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-topology-services.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-admin-services.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-system-installers.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-route-installers.ts`
- Modify: `apps/api-v1/src/composition/api-v1-runtime.ts`
- Modify: `apps/api-v1/src/composition/api-v1-background-task-lifecycle.ts`
- Modify: `apps/api-v1/src/composition/README.md`
- Modify: `apps/api-v1/src/runtime/api-process-startup.ts`
- Modify: corresponding files under `apps/api-v1/test/composition/` and `apps/api-v1/test/services/api-process-startup.test.ts`
- Create: `apps/api-v1/test/composition/api-v1-configuration-construction.test.ts`

- [ ] Add a process-startup test proving invalid configuration calls no database constructor, background-task registration, route installer, listener binder, or queue-worker start.
- [ ] Add a construction test that passes a complete fixture snapshot, denies environment permission in a spawned Deno process, and successfully constructs the server. This is the hidden-`Deno.env` detector below the process boundary.
- [ ] Add lifecycle tests for database-ready before route/listener exposure, worker start after readiness, partial-startup close, normal shutdown order, and repeated shutdown safety.
- [ ] Make `createDefaultRallarServer` require an input containing a coherent API-v1 server configuration plus explicit WebSocket customization. Remove zero-argument/default operational construction.
- [ ] Create the database lifecycle in `main.ts` immediately after configuration resolution, register its close operation with the background lifecycle, and pass its database/notification capabilities through composition.
- [ ] Pass narrow named sections to mutation runtime, topology services, admin services, CRDT, system installers, route installers, timing, resilience, and worker startup. Do not pass the complete process snapshot when a coherent section suffices; do not split one policy into unrelated scalar arguments.
- [ ] Construct timing sinks, AppInbox wait options, state resilience objects, group admission policies, topology options, queue resilience, and replay/worker decisions from required configuration. Remove module-load singleton policy objects.
- [ ] Have `main.ts` log only the safe startup summary before resource construction. Remove independent database/replay/hardening log readers.
- [ ] Make shutdown stop workers, WebSockets, background tasks, notification/listener resources, and SQL through the explicit owner. Preserve existing externally visible startup failure types after configuration succeeds.
- [ ] Run `cd apps/api-v1 && deno task test test/composition/api-v1-configuration-construction.test.ts test/composition/api-v1-background-task-lifecycle.test.ts test/composition/create-default-rallar-server.test.ts test/composition/create-api-v1-runtime.test.ts test/services/api-process-startup.test.ts` until GREEN.
- [ ] Run `cd apps/api-v1 && deno task check && deno task lint`, plus `rg -n "Deno\\.env" apps/api-v1/src --glob '!main.ts'`. The search must find no runtime operational read below the approved process boundary.
- [ ] Review all touched composition files in full, run `git diff --check`, commit with `git commit -am "refactor(api-v1): construct server from resolved configuration"` after staging new files explicitly, then `git push`.

### Slice 2 checkpoint

- [ ] Run `npm run pr:delivery -- status`. Repair only a real conflict; `BEHIND` alone creates no rebase or merge work.
- [ ] Re-run the full environment and deleted-import inventory. Confirm the remaining matches belong only to route/feature consumers, Relic, deployment, tests, docs, Prisma, or black-box runner target URLs.
- [ ] Re-inspect tasks 5 and 6 against current composition signatures and keep their file lists current.

---

## Slice 3: Migrate every API-v1 feature consumer and remove alternate group behavior

### Task 5: Inject authentication, state, group, ICE, public, and observability policy into routes

**Files:**

- Modify: `apps/api-v1/src/routes/config-route.ts`
- Modify: `apps/api-v1/src/routes/ice-route.ts`
- Modify: `apps/api-v1/src/routes/auth/register-auth-user-mutation-routes.ts`
- Modify: `apps/api-v1/src/routes/auth/register-auth-credential-mutation-routes.ts`
- Modify: `apps/api-v1/src/routes/client-state-routes.ts`
- Modify: `apps/api-v1/src/routes/graph-topology-routes.ts`
- Modify: `apps/api-v1/src/routes/state-snapshot-read/create-state-snapshot-read-route-registrars.ts`
- Modify: `apps/api-v1/src/services/api-login-service.ts`
- Modify: `apps/api-v1/src/services/read-admin-client-ids.ts`
- Modify: `apps/api-v1/src/services/group-admission-rate-limit.ts`
- Modify: `apps/api-v1/src/services/state-api-authentication-middleware.ts`
- Modify: `apps/api-v1/src/services/state-api-resilience-middleware.ts`
- Modify: `apps/api-v1/src/services/timing-service.ts`
- Modify: `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`
- Modify: route/service tests named for each owner above and their shared test runtimes
- Delete after final consumer migration: `apps/api-v1/src/config-repo.ts`
- Delete after replacement: `apps/api-v1/test/config-repo.test.ts`
- Delete: `apps/api-v1/resources/web-config-dev.json`
- Delete: `apps/api-v1/resources/web-config-prod.json`
- Delete: `apps/api-v1/resources/web-config-prod-in-memory.json`

- [ ] Change route tests first so constructors receive explicit policy fixtures. Delete environment mutation helpers from client/group route test runtimes and assert changing `Deno.env` after construction cannot change behavior.
- [ ] Add route behavior cases for auth lifetimes and all auth rate-limit families, strict state reads, state request/event/circuit policies, group join/presence quotas, local and Metered ICE with cache/rate policy, timing policy, and CRDT/AppInbox wait options.
- [ ] Change `/api/config` tests to pass the startup-created public projection and a separate operator-token issuer config. Assert authentication/authorization precede credential issue and the response contains no operational or secret field.
- [ ] Change operator-token tests to inject allowed client IDs, TTL, and signing secret directly; remove `readEnv` mocks.
- [ ] Run `cd apps/api-v1 && deno task test test/config-route-auth-logout.test.ts test/ice-route.test.ts test/routes/auth-client-mutation-idempotency-routes.test.ts test/routes/agent-session-ticket-route.test.ts test/routes/black-box-control-token-route.test.ts test/client-state/client-state-read-routes.test.ts test/group-state/group-state-read-routes.test.ts test/group-state/group-admission-rate-limit-routes.test.ts test/services/state-api-authentication-middleware.test.ts test/services/state-api-resilience-middleware.test.ts test/services/timing-service.test.ts` and confirm RED at the old environment/default seams.
- [ ] Replace module constants and default constructor arguments with required coherent policy objects. Preserve clocks/fetch/randomness as separately injectable volatile dependencies.
- [ ] Construct ICE cache state per installer/runtime rather than at module load. Metered fetch receives only the selected provider section.
- [ ] Make `requireGroupAdmissionQuota` receive the resolved config or a constructed quota owner; remove the module-global `GROUP_ADMISSION_RATE_LIMIT_CONFIG`.
- [ ] Make state resilience middleware own per-runtime `RateLimiterPolicy` and `CircuitBreaker` instances built from configuration; avoid cross-runtime singleton state.
- [ ] Make `/api/config` return only `toApiV1PublicConfiguration(snapshot)` and issue black-box tokens only from explicit issuer configuration.
- [ ] Delete lazy config resources/repository after all callers use the projection. Delete tests that protect lazy file selection and replace them with public projection behavior tests.
- [ ] Re-run the same focused route/service command until GREEN, then run `cd apps/api-v1 && deno task test` for regression coverage.
- [ ] Run `rg -n "Deno\\.env|getApiConfig|config-repo|readEnv" apps/api-v1/src apps/api-v1/test` and classify every remaining match. Only the startup reader and deliberate test/process boundaries may remain.
- [ ] Run `git diff --check`, commit with `git add -A apps/api-v1 && git commit -m "refactor(api-v1): inject resolved route policy"`, then `git push`.

### Task 6: Inject topology, replay, CRDT, admin, evidence, and queue policy

**Files:**

- Modify: `apps/api-v1/src/services/rtc-topology-config.ts` or delete it when its final translations move to configuration
- Modify or delete: `apps/api-v1/src/runtime/rtc-topology/rtc-topology-replay-config.ts`
- Modify: `apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-runtime.ts`
- Modify: `apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts`
- Modify: `apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-queue-pub-sub-bridge.ts`
- Modify: `apps/api-v1/src/runtime/rtc-topology/rtc-topology-replay-startup.ts`
- Modify: `apps/api-v1/src/runtime/rtc-topology/rtc-topology-delivery-startup.ts`
- Modify: `apps/api-v1/src/services/init-api-rtc-topology-scalar-recompute-worker.ts`
- Modify: `apps/api-v1/src/crdt/create-api-crdt-inbox-factory.ts`
- Modify: `apps/api-v1/src/crdt/create-api-crdt-inbox-service.ts`
- Modify: `apps/api-v1/src/crdt/register-crdt-admin-routes.ts`
- Modify: `apps/api-v1/src/db/pglite-black-box-evidence-snapshot.ts`
- Modify: all corresponding topology, replay, CRDT, admin, queue, and PGlite tests
- Delete obsolete configuration-only tests: `apps/api-v1/test/rtc-topology-config.test.ts`, `apps/api-v1/test/rtc-topology-replay-config.test.ts`, and `apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts` after equivalent owner tests exist

- [ ] Add/adjust focused tests first to pass complete topology, replay, worker, QueueBox resilience, AppInbox, CRDT, admin, and evidence policy explicitly.
- [ ] Add boundary tests for every topology integer/boolean formerly ignored, including zero-valid versus positive-only values. Invalid values must already have failed in configuration resolution.
- [ ] Add construction assertions that topology services and refinement gates receive exact resolved values, replay/worker modes enforce database invariants, and PGlite evidence publishing receives its directory explicitly.
- [ ] Run `cd apps/api-v1 && deno task test test/composition/create-api-v1-topology-services.test.ts test/services/rtc-topology-delivery-startup.test.ts test/crdt/crdt-inbox-construction-contract.test.ts test/admin-operations/admin-inbox-construction-contract.test.ts test/db/pglite-black-box-evidence-snapshot.test.ts` and confirm RED where readers/defaults remain.
- [ ] Replace topology `compactOptions` and environment readers with direct adaptation from the required configuration section. Every optional property passed into a shared API must originate from a meaningful discriminated mode, not decoder failure or omitted operational policy.
- [ ] Pass CRDT document policies once into inbox/service/route construction. Remove all request-time or test-time environment policy mutation.
- [ ] Pass admin target scopes and queue resilience from configuration/composition; do not move domain constants, queue keys, or AppInbox doctrine into configuration.
- [ ] Remove replay/config reader modules when their final callers are migrated. Do not retain types that only rename configuration-owned types.
- [ ] Re-run the same focused topology/CRDT/admin/PGlite command until GREEN, then run `cd apps/api-v1 && deno task check && deno task lint`.
- [ ] Run the environment/import closure search, `git diff --check`, commit with `git add -A apps/api-v1 && git commit -m "refactor(api-v1): inject resolved runtime policy"`, then `git push`.

### Task 7: Delete formation and dissemination selectors and alternate runtime branches

**Files:**

- Delete: `apps/api-v1/src/runtime/group-formation/group-formation-damping-config.ts`
- Delete: `apps/api-v1/src/runtime/group-formation/group-state-dissemination-config.ts`
- Delete: `apps/api-v1/test/group-state-dissemination-config.test.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts`
- Modify: `packages/shared-server/rallar-system/client-state/client-state-service-contracts.ts`
- Modify: `packages/shared-server/rallar-system/client-state/client-state-service.ts`
- Modify: `packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts`
- Modify: `packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts`
- Modify: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts`
- Modify: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts`
- Modify: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-result.ts`
- Modify: `packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts`
- Modify: `packages/shared-server/rallar-system/group-state/group-mutation-authority.ts`
- Modify: `packages/shared-server/rallar-system/group-state/group-state-service-contracts.ts`
- Modify: `packages/shared-server/rallar-system/group-state/group-state-service.ts`
- Modify: `packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts`
- Modify: `packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts`
- Modify: `packages/shared-server/rallar-system/group-state/mutation/presence/compute-group-presence-mutation.ts`
- Modify: `packages/shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts`
- Modify: `packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts`
- Rename: `packages/tests/shared-server/group-state/presence/group-presence-summary-dissemination-emission.test.ts` to `packages/tests/shared-server/group-state/presence/group-presence-summary-delta-emission.test.ts`
- Modify: all shared-server client/group fixtures and tests returned by the legacy search
- Modify: `packages/shared-server/rallar-system/group-state/README.md`

- [ ] First change shared-server tests to express the single canonical behavior: damped formation intent and delta-primary dissemination only. Delete cases for `legacy` and `dual-emit` instead of renaming them.
- [ ] Add an explicit test that concurrent/no-op presence summary work emits the canonical delta/outbox set exactly once and preserves current durable receipts.
- [ ] Add persisted fact decode/validation tests proving the required `formationDamping` field accepts only the literal `'damped'`; preserve the field and durable JSON shape.
- [ ] Run the focused shared-server client/group tests and confirm RED while unions and alternate branches remain.
- [ ] Remove `GroupStateDisseminationMode`, `GroupPresenceSummaryTopologyIntent` alternatives, optional damping selection, legacy topology intent construction, and dual-emission code. Make the canonical intent/dataflow direct.
- [ ] Remove `formationDamping` as a runtime option while retaining it as the required literal in durable command/result facts. Generate `'damped'` at the one authoritative fact-construction boundary.
- [ ] Remove both API environment readers, logging, composition inputs, docs, mocks, and fixtures. Do not add deprecated literal members or compatibility parsing.
- [ ] Run `rg -n "RALLAR_GROUP_FORMATION_DAMPING|RALLAR_GROUP_STATE_DISSEMINATION|dual-emit|'legacy'|disseminationMode|GroupStateDisseminationMode" apps/api-v1 packages/shared-server packages/tests/shared-server packages/shared-test docs .github scripts --glob '!docs/superpowers/**'`. There must be no production/test/docs selector or alternate branch match; investigate unrelated uses of the English word `legacy` individually.
- [ ] Run `npx vitest run packages/tests/shared-server/client-state packages/tests/shared-server/group-state` and `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
- [ ] Run affected API PGlite and composition tests, `git diff --check`, commit with `git add -A apps/api-v1 packages/shared-server packages/tests/shared-server && git commit -m "refactor(group-state): remove selectable legacy formation behavior"`, then `git push`.

### Slice 3 checkpoint

- [ ] Re-run all source inventories and inspect changed files for local aliases, optional fallback parameters, hidden module state, and stale alternate tests.
- [ ] Confirm AppInbox reservation/retry defaults and database schemas are unchanged.
- [ ] Re-inspect Relic, black-box, workflow, and Hetzner current files before tasks 8 and 9.

---

## Slice 4: Migrate embedded applications and managed runtime entry points

### Task 8: Give the Relic server one application configuration boundary

**Files:**

- Create: `apps/relic-hunter-server-v1/src/relic-hunter-server-configuration.ts`
- Create: `apps/relic-hunter-server-v1/test/relic-hunter-server-configuration.test.ts`
- Modify: `apps/relic-hunter-server-v1/src/main.ts`
- Modify: `apps/relic-hunter-server-v1/src/relic-rest-auth.ts`
- Modify: `apps/relic-hunter-server-v1/src/relic-expedition-ai.ts`
- Modify: `apps/relic-hunter-server-v1/test/relic-server-service.test.ts`
- Modify: `apps/relic-hunter-server-v1/test/relic-server-browser-contract.test.ts`
- Delete: `apps/relic-hunter-server-v1/src/config-repo.ts`
- Delete: `apps/relic-hunter-server-v1/resources/web-config-dev.json`
- Delete: `apps/relic-hunter-server-v1/resources/web-config-prod.json`
- Modify: `apps/relic-hunter-server-v1/deno.json`

- [ ] Add Relic configuration tests first for one-time resolution of Relic HTTP port/CORS/public host, REST authorization, AI provider, and the embedded API-v1 server snapshot.
- [ ] Prove Relic passes the exact already-resolved API-v1 server configuration into `createDefaultRallarServer` and no second API environment read occurs.
- [ ] Prove changing the environment after Relic construction changes neither embedded API behavior nor Relic-only behavior.
- [ ] Prove the browser projection contains only public Relic/API data and secrets stay absent.
- [ ] Run the focused Relic tests and confirm RED at the lazy config/default factory seams.
- [ ] Implement the Relic boundary. It may translate the canonical profile selector and public API URL overrides, but it must not duplicate database, auth, topology, AppInbox, ICE, CRDT, or black-box decoding.
- [ ] Pass Relic-only HTTP/auth/AI policy explicitly to their owners and the resolved API-v1 section to the embedded server factory.
- [ ] Delete Relic web config resources and lazy repository with no forwarder.
- [ ] Run `cd apps/relic-hunter-server-v1 && deno task test && deno task check && deno task lint`.
- [ ] Run relevant package tests with `npx vitest run packages/tests/relic-hunters`.
- [ ] Run `git diff --check`, commit with `git add -A apps/relic-hunter-server-v1 && git commit -m "refactor(relic): resolve embedded server configuration once"`, then `git push`.

### Task 9: Select canonical profiles in black-box orchestration and recipes

**Files:**

- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Modify: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts`
- Modify: `packages/shared-test/black-box-runner/managed-api/with-managed-api-server-plans.mts`
- Modify: affected files under `packages/shared-test/black-box-runner/tests/api-v1/`
- Modify: affected files under `packages/shared-test/black-box-runner/examples/`
- Modify: `packages/tests/shared-test/api-v1-auth-credential-env.test.ts`
- Modify: `packages/tests/shared-test/api-v1-black-box-pglite-timezone-fixture.test.ts`
- Modify: `packages/tests/shared-test/api-v1-managed-process-lifecycle.test.ts`
- Modify: `packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts`
- Modify: root `package.json` scripts only where they reconstruct removed server settings

- [ ] Add managed-process tests first proving memory/file/PostgreSQL API nodes select `dev`, `prod-in-memory`, or `prod` intentionally and pass only host/run-specific overrides plus secrets.
- [ ] Assert managed logs/artifacts redact all secret names and values according to existing redaction contracts.
- [ ] Distinguish runner target variables (`RALLAR_API_BASE_URL`, secondary, tertiary) from server startup variables. Retain runner targets; migrate only child API process configuration.
- [ ] Update recipe fixtures that intentionally override deleted group modes. Recipes must exercise the one canonical behavior without mode variables.
- [ ] Run the focused managed-runner unit tests and recipe schema tests.
- [ ] Run `npx vitest run packages/tests/shared-test/api-v1-auth-credential-env.test.ts packages/tests/shared-test/api-v1-black-box-pglite-timezone-fixture.test.ts packages/tests/shared-test/api-v1-managed-process-lifecycle.test.ts packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts`.
- [ ] Run `npm run test:api-v1:black-box:memory` and `npm run test:api-v1:black-box:postgres`. Confirm the effective profile and database mode from safe startup evidence.
- [ ] Run `npm run test:api-v1:black-box:recipes` and the focused formation/idempotency/config recipes affected by environment construction.
- [ ] If a failure matches the delayed formation-timer wake race, retain the unweakened recipe and record the matching issue classification. Do not alter timing or profile defaults.
- [ ] Run `git diff --check`, commit with `git add -A packages/shared-test package.json && git commit -m "test(black-box): select canonical API configuration profiles"`, then `git push`.

### Slice 4 checkpoint

- [ ] Re-run the environment inventory across API-v1, Relic, black-box, workflows, scripts, active docs, and tests.
- [ ] Confirm all remaining `DATABASE_URL` reads are either central API runtime secret acquisition, Prisma tooling, managed runner/database provisioning, or another app's independent process boundary.
- [ ] Re-inspect task 10 deployment targets and task 11 validation commands against current repository scripts.

---

## Slice 5: Migrate deployments, close legacy, and prove the complete program

### Task 10: Update workflows, Hetzner scripts, Deno tasks, hardening ownership, and docs

**Files:**

- Modify: `apps/api-v1/deno.json`
- Modify: `.github/workflows/api-v1-black-box.yml`
- Modify: `.github/workflows/api-v1-medium-scale-gate.yml`
- Modify: `.github/workflows/api-v1-topology-replay-gate.yml`
- Modify: `.github/workflows/branch-release-gate.yml`
- Modify: `.github/workflows/release-gate.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: relevant Hetzner workflows returned by the current inventory
- Modify: `scripts/hetzner/controller/01-install-runtime.sh`
- Modify: `scripts/hetzner/controller/02-deploy-controller.sh`
- Modify: `scripts/hetzner/controller/08-rollout-controller.sh`
- Modify: `scripts/hetzner/controller/README.md`
- Modify: other current Hetzner scripts that read/write API-v1 environment files
- Modify: `docs/environment-variables.md`
- Modify: active API-v1/Relic deployment and runbook documentation returned by the current inventory
- Modify: `packages/shared-server/http/production-env-hardening.ts`
- Modify: `packages/tests/shared-server/production-env-hardening.test.ts`
- Modify: `packages/tests/hetzner/*` and `packages/tests/repo/api-v1-black-box-workflow.test.ts` where they assert migrated settings

- [ ] Update workflow/script tests first to require `RALLAR_API_CONFIGURATION_PROFILE`, forbid removed names, and prove environment files remain mode `0600` without leaking secrets into logs/artifacts.
- [ ] Add representative non-secret fixture credentials to unit tests for a complete hardened `prod` snapshot; real secrets remain platform-provided.
- [ ] Update API Deno tasks so local absence means `dev`, memory runs select the intended canonical profile, and task-local overrides contain only true per-run differences.
- [ ] Update GitHub black-box, medium-scale, topology-replay, release-gate, and deploy workflows to select canonical profiles and remove deleted variables.
- [ ] Update Hetzner install/rollout/status paths to write/read the canonical selector and allowlist only. Preserve root ownership and `0600` permissions.
- [ ] Update Deno Deploy API-v1 and Relic configuration evidence to require `RALLAR_API_CONFIGURATION_PROFILE=prod` plus platform secrets.
- [ ] Remove API-v1/Relic helpers from the generic shared production hardening module. Retain the black-box control server's behavior behind a directly named owner if it still has verified consumers.
- [ ] Update active docs with the exact selector, profiles, precedence, allowlist, secret rules, restart-only behavior, and removed settings. Do not document aliases or transitional procedures.
- [ ] Run `npx vitest run packages/tests/hetzner packages/tests/repo/api-v1-black-box-workflow.test.ts packages/tests/shared-server/production-env-hardening.test.ts`.
- [ ] Run shell syntax checks for every changed `.sh` file and workflow/package JSON/YAML validation already owned by repository tests.
- [ ] Run `git diff --check`, commit with `git add -A apps/api-v1 apps/relic-hunter-server-v1 .github scripts/hetzner docs packages/shared-server/http packages/tests && git commit -m "ops(api-v1): deploy canonical configuration profiles"`, then `git push`.

### Task 11: Close every old path and run the complete validation matrix

**Files:**

- Modify: every support file that enters touched-file closure during final review
- Modify: `docs/superpowers/plans/2026-08-22-api-v1-operational-configuration-ownership.md` only to record factual execution checkmarks/results when the implementation workflow uses this file as its tracker
- Do not modify generated performance artifacts under `tmp/perf/`

- [ ] Run the final source searches and make each result intentional:

```text
rg -n "ENVIRONMENT|API_BASE_URL|RALLAR_GROUP_FORMATION_DAMPING|RALLAR_GROUP_STATE_DISSEMINATION|dual-emit|GroupStateDisseminationMode" apps/api-v1 apps/relic-hunter-server-v1 packages/shared-server packages/shared-test packages/tests .github scripts docs --glob '!docs/superpowers/**'
rg -n "Deno\.env|getEnv\(|readEnv" apps/api-v1/src apps/relic-hunter-server-v1/src
rg -n "getSql|getListenSql|startListening|config-repo|web-config-(dev|prod)" apps/api-v1 apps/relic-hunter-server-v1 packages .github scripts docs
rg -n "from ['\"][^'\"]*\\\\" apps packages scripts tests
```

- [ ] Retain only `RALLAR_API_BASE_URL` canonical server override and black-box runner target inputs. Ensure the obsolete unprefixed `API_BASE_URL` is not accepted by server code.
- [ ] Confirm lower API-v1 layers have no process environment reads; only `main.ts` source acquisition and `prisma.config.ts` tooling may cross the API-v1 environment boundary.
- [ ] Confirm there is one database lifecycle, one configuration snapshot, no lazy web-config resources, no legacy/dual group branch, no backslash import continuation, and no deprecated forwarding import.
- [ ] Run `npm run pr:delivery -- status` before broad validation. Repair an actual conflict first; do not rebase or merge merely for `BEHIND`.
- [ ] Run the full API-v1 checks:

```text
cd apps/api-v1 && deno task test
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno task lint
```

- [ ] Run the full Relic and shared-server checks:

```text
cd apps/relic-hunter-server-v1 && deno task test
cd apps/relic-hunter-server-v1 && deno task check
cd apps/relic-hunter-server-v1 && deno task lint
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-server
```

- [ ] Run managed/deployment and repository tests:

```text
npx vitest run packages/tests/hetzner packages/tests/repo/api-v1-black-box-workflow.test.ts
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:changed -- origin/main WORKTREE
npm run check:repo-structure
npm run check:test-structure-coupling
```

- [ ] Run the required unweakened black-box matrix:

```text
npm run test:api-v1:black-box:recipes
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:crdt
npm run test:api-v1:black-box:postgres:formation-large
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
```

- [ ] From a freshly migrated PostgreSQL database, capture and compare the affected state-write candidate:

```text
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
```

- [ ] Trigger and pass Branch Release Gate. Record the run URL in the PR without adding governance metadata files.
- [ ] Review every touched file in full for cognitive indirection, ownership, direct imports, type names, test semantics, and complete legacy closure. Run `git diff --check` and `git status --short`.
- [ ] Commit any factual closure repairs in one named commit, push, and wait for PR checks. Do not create an empty closure commit.
- [ ] Update the implementation PR with completed behavior, exact validation results, known independently tracked formation-race classification if encountered, and rollback risk. Keep it draft until implementation and required checks are complete.
- [ ] Run `npm run pr:delivery -- ready` exactly once at handoff. When GitHub reports the PR merged, stop.

## Spec Coverage and Risk Guardrails

| Approved design area | Implemented by |
|---|---|
| Purpose, scope, target ownership, and required configuration contract | Global constraints, contract ledger, tasks 1-2 |
| Source precedence, exact profiles, environment allowlist, hardening, and immutable resolution | Source/profile rules, tasks 1-2 |
| Aggregate deterministic failures, secret redaction, startup summary, and public projection | Tasks 1-2 and task 5 |
| Side-effect-free resolution, construction dataflow, and shutdown ordering | Tasks 3-4 |
| Database, LISTEN, NOTIFY, PGlite bootstrap/evidence, and close ownership | Task 3 |
| Route/service auth, state, group, ICE, timing, AppInbox, token, and public policy | Task 5 |
| Topology, replay, workers, CRDT, admin, queue resilience, and evidence policy | Task 6 |
| Direct deletion of formation/dissemination selectors and alternate runtime behavior | Task 7 |
| Relic embedding and Relic-only configuration ownership | Task 8 |
| Black-box managed process/profile migration | Task 9 |
| GitHub, Hetzner, Deno Deploy/task, hardening, and documentation migration | Task 10 |
| Semantic tests, full application/black-box validation, performance proof, touched-file closure, and PR delivery | Every task's RED/GREEN checks and task 11 |

- The primary regression risk is a missed hidden reader producing different effective policy. The no-environment-permission construction test plus final source inventory makes this observable.
- The lifecycle risk is resource leakage or changed database ordering. Task 3 tests construction failure and close-once behavior; task 4 tests readiness and shutdown order; task 11 runs PostgreSQL concurrency and performance evidence.
- The behavior-removal risk is accidental persisted-format change. Task 7 retains the required `formationDamping: 'damped'` fact field while deleting runtime selection and alternate branches.
- The deployment risk is a profile/secret mismatch. Task 10 validates representative hardened production input and managed scripts without logging secret values; real startup still fails closed before resource creation.
- There is no data migration and no compatibility rollback path. If the PR must be rolled back before merge, revert its commits as a unit. After deployment, roll back the application revision and its matching environment profile selection together; do not restore removed aliases or dual readers in a hot fix.

## Completion Evidence

The work is complete only when all of the following are true:

- One immutable API-v1 configuration snapshot is resolved before any externally visible side effect.
- Every recognized API-v1 environment variable is translated by one documented allowlist, with exact profiles and deterministic aggregate failures.
- All secret values remain environment-only, error-safe, log-safe, artifact-safe, and absent from the public projection.
- Every API-v1/Relic runtime consumer receives required resolved policy without hidden environment access or operational defaults.
- SQL, LISTEN, NOTIFY, PGlite bootstrap/evidence, readiness, and close are owned by one explicit database lifecycle.
- API-v1 and Relic lazy config repositories and web-config resources are deleted.
- `ENVIRONMENT`, unprefixed `API_BASE_URL`, group formation damping selection, group dissemination selection, legacy formation behavior, and dual emission are absent with no compatibility shim.
- Persisted formation facts retain their required shape and use only the canonical `'damped'` literal.
- Deployment, Hetzner, Deno, black-box, tests, and active docs select canonical profiles and use only allowlisted overrides.
- Focused tests, full API-v1/Relic/shared-server suites, repository checks, black-box matrix, performance comparison, and Branch Release Gate pass, with the independent formation-timer race handled only by classification.
- The implementation PR contains the current commits, validation evidence, risk/rollback summary, and no unpushed work.
- Every changed human-authored file has been reviewed and remediated in full.
- Every support file modified by that remediation has entered closure recursively until closure.
- Independent untouched code remains outside closure.
