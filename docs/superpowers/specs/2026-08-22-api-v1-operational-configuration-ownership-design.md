# API-v1 Operational Configuration Ownership Design

## Purpose

API-v1 currently discovers operational policy through JSON resources, process environment reads,
module-load constants, factory defaults, and shared production-hardening helpers. This design makes
`apps/api-v1/src/configuration/` the sole owner that resolves API-v1 operational configuration. It
loads and validates one complete immutable snapshot before database connections, middleware,
routes, background tasks, queue workers, or the HTTP listener are created.

The change is an ownership and configuration-contract refactor. Existing REST, WebSocket, RTC,
CRDT, AppInbox, persistence, and public Rallar contracts remain unchanged unless this design
explicitly removes a configuration-selected legacy behavior. There is no compatibility shim,
deprecated duplicate, forwarding module, fallback reader, alias, or dual configuration path.

This design applies to current `main` at
`197d5cad15ac746a855e3684c48b47091e9f55d2`. Current source and current repository standards are
authoritative. Historical plans remain evidence only for the behavior they introduced.

## Current evidence

The process boundary is `apps/api-v1/src/main.ts`, but it currently resolves only CORS origins and
the HTTP port itself. It invokes production hardening, logging helpers, replay policy, formation
policy, timing, resilience, and `createDefaultRallarServer()`, each of which can read the environment
again.

The current construction path has these concrete ownership problems:

- `createDefaultRallarServer()` reads database, pub/sub, authentication, CRDT, AppInbox, topology,
  formation, capacity, dissemination, rate-limit, and timing configuration while constructing
  services.
- database selection is repeated behind `getSql()`, the exported `sql` proxy, the notification
  helper, and a separately configured module-global listener connection;
- routes read strict authorization, ICE, Metered credentials, operator-token configuration,
  registration policy, and rate limits during module load or request handling;
- topology readers silently ignore several malformed integer values while other readers throw and
  others fall back;
- production hardening validates raw environment variables independently of the effective values
  used by consumers;
- `config-repo.ts` lazily loads browser configuration and accepts both `RALLAR_API_BASE_URL` and the
  obsolete `API_BASE_URL` alias;
- API-v1 profile selection uses `ENVIRONMENT`, including an undocumented `production` synonym;
- `RALLAR_GROUP_FORMATION_DAMPING=legacy` and
  `RALLAR_GROUP_STATE_DISSEMINATION=dual-emit` retain alternate production behavior;
- the Relic server embeds API-v1 but causes the same shared operational values to be read again,
  while separately reading its HTTP, public URL, authorization, and AI settings;
- test and deployment entry points recreate defaults through environment fragments instead of
  selecting and overriding a complete documented profile.

The affected setting families include HTTP and public URLs; SQL, connection pools, PGlite,
database notifications, and evidence snapshots; authentication modes, identities, secrets,
lifetimes, and rate limits; group capacity and admission; topology planning, refinement, replay,
workers, and recompute limits; AppInbox waiting and timing; ICE; CRDT rollout; black-box token
brokerage; state API resilience; and process lifecycle behavior.

Hardcoded algorithm and protocol invariants are not operational configuration merely because they
are numeric. AppInbox reservation and retry doctrine, persisted formats, protocol paths, mutation
error codes, request validation limits, queue key construction, and domain contracts remain owned
by their existing code.

## Considered approaches

### Selected: one app-owned resolved configuration snapshot

API-v1 owns profile resources, environment translation, secret acquisition, complete validation,
redaction, and the canonical immutable configuration. The process boundary resolves it once and
passes exact sections through construction.

This produces the shortest truthful path from deployment input to runtime behavior. It permits
strict startup validation and makes lower layers testable without process environment access.

### Rejected: retain feature-local environment readers behind common helpers

A common `readEnv` or typed environment helper would make parsing more consistent but would retain
distributed ownership and time-of-read differences. Effective configuration would still be hard to
inspect and factories could still conceal defaults.

### Rejected: inject an environment reader through the composition tree

Passing `EnvReader` instead of `Deno.env` would improve test substitution but would expose the
deployment representation throughout domain and service construction. It would not establish a
canonical configuration contract or prevent repeated interpretation.

## Scope

This change owns all API-v1 operational settings currently read from the process environment and
all app-local hardcoded values that are legitimate deployer policy. It migrates API-v1, the Relic
server's embedded API-v1 construction, API-v1 black-box startup, GitHub workflows, Hetzner scripts,
active documentation, and tests.

It does not:

- change database schemas or migrate persisted data;
- change AppInbox reservation, retry, idempotency, receipt, transaction, or outbox behavior;
- change REST paths, HTTP bodies, OpenAPI request defaults, WebSocket topics, or RTC protocols;
- centralize black-box control-server configuration under API-v1;
- centralize Relic-only game, REST authorization, AI-provider, or HTTP-host policy under API-v1;
- introduce a configuration service, remote configuration store, reload endpoint, file watcher, or
  mutable runtime update;
- preserve an old import path, setting alias, legacy behavior selector, or compatibility adapter.

Prisma remains a tool-owned process boundary. `apps/api-v1/prisma.config.ts` continues to read the
`DATABASE_URL` required by Prisma commands; it does not import the runtime configuration owner.

## Target ownership

The owning area is:

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
```

This is a responsibility map, not an instruction to preserve one file per noun. During
implementation, decoding helpers with the same callers and reason to change are consolidated.
Separate files remain only for a real configuration contract, source translation, failure,
redaction, or public-projection boundary. There is no nested barrel; consumers import the direct
owner.

`api-v1-configuration.ts` owns the canonical required configuration contract. It uses nested
domain sections and discriminated unions for mode-dependent values. It does not export rename-only
aliases.

`read-api-v1-configuration.ts` is the only process-facing reader. It selects resources, reads the
allowlisted environment settings and secrets, invokes decoding and cross-field validation, and
returns one deeply immutable snapshot. It accepts explicit source ports in tests; production passes
`Deno.env` and resource URLs at the process boundary.

`decode-api-v1-configuration.ts` owns exact JSON shapes, source overlay decoding, normalization,
and cross-field invariants. It has no process, database, network, clock, or global-state dependency.

`api-v1-configuration-error.ts` owns the complete startup failure and safe rendering. It never
stores or renders secret values.

`to-api-v1-public-configuration.ts` owns the deliberate projection used by `/api/config`. It cannot
receive or serialize secret fields accidentally.

The existing `authorised-clients.json` remains a separate demo-auth data resource. The configuration
owner loads and validates it once, and the canonical configuration contains the resulting static
client records. Production profiles disable their use.

## Configuration contract

`ApiV1Configuration` is a complete required object. Optional fields are permitted only when absence
has domain meaning inside a discriminated mode. Consumers do not apply defaults.

The top-level sections are:

- `profile`: selected profile identity and effective hardening mode;
- `http`: port, allowed CORS origins, preflight lifetime, and process resilience policy;
- `publicApi`: API and WebSocket base URLs exposed to browser consumers;
- `database`: a discriminated PostgreSQL, PGlite file, or PGlite memory configuration, including
  connection pools, schema bootstrap, pub/sub, and optional black-box evidence publication;
- `authentication`: registration and static-client modes, admin client IDs, credential secret,
  session and ticket lifetimes, and login, registration, and ticket rate limits;
- `stateApi`: strict read authorization plus request, event-list, and circuit-breaker policy;
- `group`: capacity and admission rate-limit policy;
- `topology`: planner thresholds, RTT reporting/refinement, recompute debounce and limits, replay,
  queue-worker mode, and topology delivery policy;
- `appInbox`: completion-wait policy and phase-timing instrumentation;
- `ice`: a discriminated local or Metered configuration, cache lifetime, and rate limit;
- `crdt`: canonical document-type rollout policies;
- `blackBox`: operator-token issuer policy and PGlite evidence settings;
- `observability`: timing-log and safe startup-summary policy.

The PostgreSQL variant requires a database URL, application pool values, and listener pool values.
It alone permits PostgreSQL pub/sub. The PGlite variants require their appropriate storage and
bootstrap settings and permit only local or disabled pub/sub. The Metered ICE variant requires app
name, API key, and region; the local variant contains none of those credentials.

Server-generated IDs, clocks, HTTP fetch implementations, SQL clients, repositories, and lifecycle
objects are construction dependencies, not configuration values.

## Sources and precedence

The canonical selector is `RALLAR_API_CONFIGURATION_PROFILE`. Its values are exactly `dev`, `prod`,
and `prod-in-memory`; matching is case-sensitive after rejecting surrounding whitespace. Absence
selects `dev`. The old `ENVIRONMENT` selector and its `production` synonym are removed.

Sources are applied once in this order:

```text
defaults-config.json
  -> selected profile JSON
  -> canonical allowlisted environment overrides
  -> environment-only secrets
  -> exact decode, normalization, and cross-field validation
  -> immutable ApiV1Configuration
```

Later sources override earlier values only at explicitly mapped leaf fields. Generic dotted paths,
JSON-in-one-variable configuration, arbitrary environment walking, and recursive object merging are
not supported.

JSON resources are exact objects. Unknown properties, missing required profile values, wrong types,
non-finite numbers, unsafe integers, invalid URLs, invalid origins, duplicate set-like values, and
invalid enum values are failures. Ordered arrays retain order. Set-like client IDs, origins, and
CRDT policies use their domain canonicalization before the final snapshot is frozen.

Unrelated process environment variables are ignored because a process commonly receives platform
and tool settings. Every recognized API-v1 variable is documented in one allowlist mapping. Empty
values are rejected when the setting is required; they do not silently erase or select defaults.

## Profile policy

`defaults-config.json` contains common, non-secret operational defaults. Each profile overlay is
small and states only intentional differences.

- `dev` selects PGlite memory, local pub/sub, local ICE, public registration, demo static clients,
  local URLs and origins, strict decoding, and development hardening.
- `prod` selects PostgreSQL, PostgreSQL pub/sub, Metered ICE, admin registration, disabled static
  clients, strict state-read authorization, explicit HTTPS/WSS URLs and origins, and production
  hardening. Required credentials remain environment-only.
- `prod-in-memory` selects the production-facing public URL family with PGlite memory and local
  process delivery for disposable hosted validation. It is not the durable production profile and
  does not weaken or masquerade as `prod`.

`prod` always enables production hardening. `RALLAR_PRODUCTION_HARDENING=1` may promote another
profile to the same cross-field hardening checks for validation, but no environment value can
disable hardening selected by `prod`.

Production hardening validates the effective snapshot, not raw source presence. It requires
PostgreSQL and PostgreSQL pub/sub, exact HTTPS/WSS public URLs and CORS origins, strict state reads,
admin-only registration, non-demo admin identities, disabled static clients, a valid stable auth
credential secret, Metered ICE, and explicit black-box operator-token policy. Errors identify the
configuration path and relevant environment name without values.

## Environment contract

Existing canonical deployment variables remain supported only through the central allowlist:

- Profile: `RALLAR_API_CONFIGURATION_PROFILE` and `RALLAR_PRODUCTION_HARDENING`.
- HTTP and public endpoints: `PORT`, `CORS_ORIGINS`, `RALLAR_API_BASE_URL`, and
  `RALLAR_WS_BASE_URL`.
- Database: `RALLAR_SQL_BACKEND`, `DATABASE_URL`, `RALLAR_PGLITE_DATA_DIR`,
  `RALLAR_PGLITE_SCHEMA_INIT`, `RALLAR_DB_PUBSUB`, and
  `RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR`.
- Authentication: `AUTH_REGISTRATION_MODE`, `AUTH_ADMIN_CLIENT_IDS`,
  `AUTH_STATIC_CLIENTS_MODE`, `RALLAR_AUTH_CREDENTIAL_SECRET`, `RALLAR_LOGIN_IP_RATE_LIMIT`, and
  `RALLAR_LOGIN_USER_RATE_LIMIT`.
- State API: `RALLAR_STATE_STRICT_READ_AUTH`.
- Group admission: `RALLAR_GROUP_DEFAULT_MAX_MEMBERS`,
  `RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT`,
  `RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT`,
  `RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT`, and
  `RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT`.
- Topology: `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT`, `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`,
  `RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE`, `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE`,
  `RALLAR_RTC_TOPOLOGY_MESH_PARAM_K`, `RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH`,
  `RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH`, `RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS`,
  `RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW`,
  `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS`, `RALLAR_RTC_TOPOLOGY_REPLAY`, and
  `RALLAR_API_QUEUE_WORKERS`.
- AppInbox and observability: `RALLAR_APP_INBOX_PHASE_TIMING`,
  `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`, `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`, `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`, and
  `RALLAR_TIMING_LOGS`.
- ICE: `RALLAR_ICE_MODE`, `METERED_APP_NAME`, `METERED_API_KEY`, and `METERED_REGION`.
- CRDT: `RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON`.
- Black-box token issue: `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`,
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`, and `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`.

The implementation inventory must reconcile every current API-v1 read against this table before an
old reader is deleted. Missing currently hardcoded deployer policy receives a named JSON field and
default, including authentication session and ticket lifetimes, registration and ticket rate
limits, ICE cache and rate policy, HTTP preflight lifetime, state API resilience, database pool
sizes, and QueueBox resilience values. Such new JSON fields do not automatically receive new
environment overrides; an override is added only when deployment evidence needs one.

`API_BASE_URL`, `ENVIRONMENT`, `RALLAR_GROUP_FORMATION_DAMPING`, and
`RALLAR_GROUP_STATE_DISSEMINATION` are removed. Their readers, types, logging, tests, docs, and
alternate runtime branches are deleted. No renamed alias accepts them.

## Secret ownership and redaction

The following values are environment-only secrets and never appear in committed JSON:

- `DATABASE_URL`;
- `RALLAR_AUTH_CREDENTIAL_SECRET`;
- `METERED_API_KEY`;
- `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`.

The configuration object contains the secrets because explicit constructors require them, but its
safe logging and public projection types cannot contain them. Configuration errors include source,
path, code, and explanation only. They never include raw input, parsed URLs with credentials,
authorization material, hashes, tokens, or serialized source objects.

Startup logs one redacted summary containing the profile, hardening mode, non-secret mode choices,
public origins and URLs, enabled worker categories, and the names of applied environment overrides.
It reports secret presence only where operationally useful. It never reports secret length or a
derived fingerprint.

## Construction and dataflow

The API-v1 startup sequence is:

1. The process boundary loads dotenv for local execution.
2. `readApiV1Configuration()` loads resources, applies the allowlist and secrets, validates every
   source and cross-field invariant, and returns the immutable snapshot.
3. Startup logs only the redacted summary.
4. One database lifecycle owner creates the selected SQL client. PostgreSQL construction also
   creates the explicitly configured notification/listener connection; PGlite construction owns
   schema bootstrap and optional evidence-snapshot publication.
5. Queue pub/sub and topology cluster transport receive the database notification capabilities
   explicitly. They do not import `db.ts`, `db-listen.ts`, or `db-notify.ts` globals.
6. The background-task lifecycle owns database close, runtime expiry, topology delivery, timing,
   and every later registered stop.
7. `createDefaultRallarServer` receives a required input containing the API-v1 server configuration
   and the explicit WebSocket customization value. It reads no environment and selects no
   operational default.
8. Runtime, topology, admin, CRDT, system installers, route installers, middleware, and public
   configuration projection receive their exact required sections.
9. Routes are mounted and middleware is created from the resolved policy.
10. The HTTP listener starts, readiness completes, and queue workers start according to the
    resolved topology replay policy.
11. Shutdown stops workers, WebSockets, background tasks, listeners, and database resources through
    the same explicit lifecycle.

`createDefaultRallarServer` does not receive the entire process configuration when a narrower
server-construction section suffices. Conversely, construction does not split one coherent policy
into arbitrary scalar arguments. Named domain configuration sections are passed directly.

Routes receive resolved objects rather than an environment reader. Authentication routes receive
lifetimes and rate policies; state routes receive authorization and resilience policy; group routes
receive admission policy; ICE receives its discriminated provider and cache policy; `/api/config`
receives its public projection and explicit operator-token issuer; CRDT receives canonical policies;
admin and topology receive their resolved limits and identities.

Volatile dependencies such as `Date.now`, `crypto.randomUUID`, and `fetch` remain explicit
construction dependencies where tests replace them. They are not stored in configuration.

## Database lifecycle ownership

The selected database owner returns the normalized `PSqlSql` required by repositories plus the
mode-specific notification capabilities and one close operation. It owns:

- PostgreSQL application pool creation and closure;
- the dedicated PostgreSQL LISTEN connection and its pool policy;
- NOTIFY serialization and listener payload delivery;
- PGlite construction, readiness, schema bootstrap, evidence publication, and closure.

`getSql`, the exported callable `sql` proxy, `getListenSql`, module-global listener state, and
notification modules with hidden database selection are removed. Every current consumer imports the
new lifecycle owner or receives its capabilities from composition. PostgreSQL URL normalization
remains one explicit translation and never logs credentials.

The owner does not absorb repositories, AppInbox transactions, topology decisions, queue behavior,
or domain persistence policy. It owns connection construction and lifecycle only.

## Relic server boundary

The Relic server continues to embed the API-v1 Rallar runtime, so it resolves the canonical API-v1
server configuration once and passes it to `createDefaultRallarServer`. It does not trigger a
second environment read inside API-v1.

Relic-specific HTTP port and CORS, public host projection, REST authorization mode, and expedition
AI provider settings remain owned by a Relic application configuration boundary. That boundary is
also resolved once before construction. It may translate the shared profile selector and canonical
API public URL overrides, but it does not duplicate API-v1 database, auth, topology, AppInbox, ICE,
CRDT, or black-box policy decoding.

The Relic server's `web-config-*.json` files and lazy `config-repo.ts` are deleted after its public
configuration is projected from the resolved Relic/API snapshot. Relic passes its intentional
WebSocket settings explicitly. No old default factory call remains.

## Public configuration route

`/api/config` returns a startup-created `ApiConfig` projection containing only browser-owned public
values. It no longer imports a lazy configuration repository or reads a file during request
handling.

Black-box operator-token brokerage remains a request-time authenticated effect because it issues a
fresh credential. The route receives a resolved issuer configuration containing allowed client IDs,
TTL, and signing secret. Authentication and authorization precede issue. The secret and internal
operational configuration are never part of the JSON projection.

The old API-v1 and Relic `web-config-*.json` resources are removed after their values move into the
new application profiles. `RALLAR_API_BASE_URL` is the only API base URL override. The WebSocket
endpoint path remains code-owned protocol policy; only the public base URL is configuration.

## Failure behavior

Configuration resolution is fail-closed and completes before externally visible side effects. A
missing resource, unreadable JSON, invalid source value, missing secret, unknown JSON property, or
cross-field contradiction yields one `ApiV1ConfigurationError` containing every independently
detectable issue.

Each issue has:

- a source category: defaults, profile, environment, secret, or invariant;
- a canonical configuration path;
- an optional canonical environment name;
- a stable machine-readable code;
- a human-readable message that contains no supplied value.

Issues are sorted deterministically by source and path. Source decoding continues after an invalid
field where it is safe, allowing one startup attempt to report all configuration repairs. Cross-field
checks run against successfully decoded fields and add relationship issues without replacing source
issues.

No fallback is applied after an explicit invalid value. No catch converts configuration failure to
an empty object, feature disablement, local mode, or default. Startup does not create a SQL client,
bind a listener, schedule work, or mount routes after configuration failure.

Once configuration succeeds, failures in database connection, schema bootstrap, runtime readiness,
or HTTP binding retain their existing typed/runtime behavior. The construction lifecycle closes any
resources already created before surfacing the failure.

Mutating the process environment after resolution cannot affect the running process. Restart is the
only supported configuration update mechanism.

## Legacy removal and touched-file closure

Every repository consumer of the affected readers migrates directly. The implementation deletes:

- API-v1 and Relic lazy `config-repo.ts` owners and old web-config resources;
- API/public URL aliases and old environment-profile selectors;
- feature-local environment readers and route-level `readEnv` dependencies;
- database and listener globals, proxies, and default readers;
- API-v1/Relic functions in the generic shared production-environment hardening module, leaving the
  black-box control server with a directly named owner;
- group formation damping and dissemination configuration modules, their alternate modes, and the
  underlying legacy and dual-emission runtime branches;
- tests, mocks, examples, docs, and deployment inputs that protect or use the removed paths.

There is no re-export, deprecated name, overload, compatibility JSON, dual read, warning period,
fallback, or production-legacy registry entry. A verified external protocol, persisted format, or
consumer not visible in the repository would be a new compatibility decision and must stop
implementation for maintainer direction; current internal tests and imports are migrated rather
than preserved.

Every changed human-authored file is reviewed and remediated in full. Every support file changed by
that remediation enters closure recursively until closure. Independent untouched code remains
outside closure.

## Deployment migration

Every API-v1 process entry selects a profile explicitly except local development, where absence
means `dev`:

- `apps/api-v1/deno.json` development and memory tasks use the canonical selector and only necessary
  per-run overrides;
- API-v1 black-box orchestration selects `dev` or `prod-in-memory` for PGlite and `prod`-equivalent
  PostgreSQL settings without reconstructing hidden defaults;
- GitHub black-box, medium-scale, topology-replay, release-gate, and deploy workflows use canonical
  variables and remove deleted aliases;
- Hetzner initial deployment writes the intended profile plus the small set of host-specific
  overrides and secrets to its root-owned environment files;
- Hetzner rollout updates the same canonical allowlist and never edits an obsolete setting;
- Deno Deploy API-v1 and Relic applications set `RALLAR_API_CONFIGURATION_PROFILE=prod` in their
  runtime environment and provide required secrets through the platform secret store;
- status and runbook output name the selected profile and database mode without printing secrets.

Production deployment cannot be proven safe by a workflow variable alone. Unit tests construct a
complete representative `prod` configuration with non-sensitive fixture credentials, while real
startup validates the actual platform environment before opening resources.

Deployment scripts continue to keep secret files mode `0600`. Generated or logged audit files do
not receive configuration secrets.

## Semantic test design

Each retained test protects an independent behavior rather than a private helper or file layout.

### Configuration owner

Focused tests prove:

- absent selector chooses `dev`; all three exact selectors load the intended profile; removed and
  malformed selectors fail;
- defaults, profile, allowlisted environment overrides, and secrets follow the exact precedence;
- unknown JSON properties, missing required fields, invalid scalar types, invalid URLs/origins,
  malformed lists, malformed CRDT policy JSON, and invalid enums fail;
- invalid topology integers and booleans fail instead of disappearing into defaults;
- mode-dependent database, pub/sub, ICE, replay, worker, authentication, and production-hardening
  contradictions are aggregated;
- issue ordering is deterministic and secret values are absent from errors, logs, snapshots, and
  public projection;
- set-like inputs canonicalize while ordered inputs retain order;
- the returned snapshot is deeply immutable and later source/environment mutation does not change
  consumer behavior;
- `prod` cannot be weakened and a non-production profile can be promoted to hardening;
- public projection contains exactly public values and cannot expose a secret field.

Tests derive expected values independently from production decoders and builders.

### Construction and lifecycle

Focused tests prove:

- invalid configuration creates no database, background task, route, or listener effect;
- PGlite memory, PGlite file, and PostgreSQL each construct the correct owned resources from the
  snapshot;
- PostgreSQL application and listener pools receive the resolved policies and close once through
  the lifecycle;
- Queue pub/sub and topology transports use explicit notification ports with no global SQL lookup;
- `createDefaultRallarServer` constructs from required configuration without environment access;
- a spawned composition smoke runs without environment permission after receiving a fixture
  snapshot, detecting hidden `Deno.env` reads below the process boundary;
- routes receive and enforce the resolved auth, state, group, ICE, CRDT, token, topology, and timing
  policies;
- API-v1 and Relic pass one resolved API server snapshot, and changing the environment after
  construction has no effect;
- startup failure closes partial resources, and normal repeated shutdown is safe.

Interaction counts are asserted only for required lifecycle effects such as one resource creation
or close. Behavior and captured owned-port effects remain the primary evidence.

### Deployment and repository consumers

Script and workflow tests prove each managed runtime selects the canonical profile, writes only
allowlisted overrides, preserves root-only secret handling, and no longer emits removed variables.
Documentation examples use the same names.

A final repository search reconciles every former environment read and deleted import. This search
is completion evidence, not the primary behavioral test and not a permanent exact-tree test.

## Application and black-box validation

Implementation runs focused tests after each slice, then at least:

```text
cd apps/api-v1 && deno task test
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno task lint
cd apps/relic-hunter-server-v1 && deno task test
cd apps/relic-hunter-server-v1 && deno task check
cd apps/relic-hunter-server-v1 && deno task lint
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-server
npx vitest run packages/tests/hetzner packages/tests/repo/api-v1-black-box-workflow.test.ts
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:recipes
npm run test:api-v1:black-box:postgres:crdt
npm run test:api-v1:black-box:postgres:formation-large
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
npm run test:repo-governance
npm run check:repo-style:changed
npm run check:repo-structure
npm run check:test-structure-coupling
```

The implementation moves database pool and notification construction and makes pool policy
configurable. Treat that as an affected database-concurrency boundary even though transaction
semantics are intended to remain unchanged. Produce a fresh state-write candidate from a freshly
migrated database and pass the governed comparison; do not reuse a diagnostic artifact as current
evidence.

The medium-scale and topology-replay workloads remain unweakened. The independent delayed
formation-timer wake race is not fixed or hidden by this plan; any affected recipe failure is
classified against that known issue rather than changing configuration defaults or test timing.

Before broad final validation, run `npm run pr:delivery -- status` and repair an actual conflict
first. The affected PR requires Branch Release Gate. At handoff, run
`npm run pr:delivery -- ready` once.

## Implementation slicing

Only the next two independently testable slices stay concrete at a time.

The first slice establishes the pure contract, profile resources, source precedence, strict
decoder, aggregate/redacted failure, public projection, and focused configuration tests. It does
not migrate runtime consumers until the new owner is complete and directly tested.

The second slice resolves configuration at startup, establishes explicit database lifecycle and
required server construction, and migrates the first complete API-v1 composition path. It removes
the superseded database/configuration globals within the same touched-file closure.

Later outcome-shaped work migrates route and feature consumers, deletes legacy formation and
dissemination paths, migrates Relic, updates deployment and black-box entry points, and closes the
full validation matrix. After every two completed slices, current source and tests select the next
two concrete slices.

Coherent reviewed slices are committed and pushed to one draft pull request. The PR body uses only
Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up.

## Acceptance criteria

The implementation is complete only when current repository and runtime evidence proves all of the
following:

1. API-v1 has one app-owned configuration entry and one complete immutable snapshot per process.
2. The snapshot is resolved and fully validated before any database, route, worker, background, or
   listener side effect.
3. No API-v1 code outside the configuration source adapter reads `Deno.env`, accepts an
   environment reader, or selects an operational default.
4. Every legitimate operational value is in the canonical contract; protocol and algorithm
   invariants remain code-owned.
5. Database, notification, and PGlite resources have one explicit construction and shutdown owner;
   the SQL proxy and listener globals are gone.
6. API-v1 and Relic both pass required resolved server configuration to
   `createDefaultRallarServer`.
7. `/api/config` uses a safe startup projection, and request-time token brokerage receives explicit
   issuer policy without exposing secrets.
8. Production hardening validates the effective snapshot and cannot be disabled for `prod`.
9. All configuration failures are aggregate, deterministic, fail-closed, and secret-safe.
10. `API_BASE_URL`, `ENVIRONMENT`, the two legacy group mode settings, their old imports, and their
    alternate runtime branches are absent.
11. No compatibility shim, deprecated export, re-exporting old path, dual reader, or fallback
    remains.
12. API-v1, Relic, deployment, focused semantic, black-box, structure, style, coupling, and Branch
    Release Gate evidence passes or is explicitly classified with authoritative external evidence.
13. Every changed human-authored file is reviewed and remediated in full; support-file remediation
    recursively closes; independent untouched code remains outside closure.

## Risk and rollback

The primary risk is an omitted current setting or a profile that resolves differently from a
deployed environment. The mitigation is a mechanically reconciled current-reader inventory,
independent precedence tests, representative production profile tests, deployment-script tests, and
black-box execution in memory and PostgreSQL modes.

A second risk is opening resources before complete validation or leaking a credential through a
failure or summary. Construction-effect tests and secret canaries cover both boundaries.

Rollback is a Git revert of the complete change. There is no database migration, persisted-format
change, runtime compatibility flag, or dual configuration mode to unwind. Operators restore the
prior deployment environment when reverting. The implementation must not create a rollback setting
that preserves the deleted runtime path.

## Follow-up

No independent follow-up is required by this design. Material unrelated defects discovered during
implementation are checked against open GitHub issues and receive a focused issue only when no
accurate owner exists. An issue never substitutes for completing a dependent acceptance criterion.
