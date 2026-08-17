# API-v1 Composition And SQL Boundary Refactor Design

## Purpose

This design closes [issue #237](https://github.com/intact-software-systems/ar-eye-hunter/issues/237)
with a behavior-preserving ownership refactor of the API-v1 composition root. It makes default
construction, required assembly, SQL normalization, runtime ownership, route dependencies, and
background-task lifecycle visible without changing API, WebSocket, AppInbox, persistence, or
topology behavior.

The requested outcome remains the intended outcome throughout touched-file remediation. Actual bugs
found during implementation receive a failing semantic test and a fix. Other confirmed code or
performance weaknesses are checked against open issues and receive a focused issue when no accurate
owner exists.

## Current evidence

Current `main` is `04615706883bef612cdf40f13e488a98644b8710`. The current construction path starts
at `apps/api-v1/src/main.ts`, calls `createRallarServer()`, defaults through
`initialiseMiddleware()`, creates repositories and services in two broad factories, registers routes
and installers, and returns `RallarServerApplication`.

The current shape has the following concrete problems:

- `apps/api-v1/src/create-rallar-server.ts` combines topology policy and repositories, RTT mutation
  wiring, admin services, route assembly, WebSocket topics, lifecycle installation, and application
  construction.
- `apps/api-v1/src/middleware.ts` combines database adaptation, QueueBox and repository creation,
  state caches, AppInbox factories, RTC runtime construction, startup work, global runtime storage,
  and shutdown registration.
- `CreateRallarServerOptions` makes seven production inputs optional and hides their defaults inside
  `createRallarServer`.
- Production construction repeats `sql as unknown as PSqlSql` across `create-rallar-server.ts`,
  `middleware.ts`, and app-local repository factories instead of owning one adapter boundary.
- A module-global `middleware` plus `getMiddleware()` acts as a service locator for auth, client,
  group, graph, configuration, WebSocket, and state-sync paths.
- Admin and statistics services capture `rallarApplication` before it is assigned so they can read
  WebSocket status later.
- Background task state is module-global rather than owned by the API runtime whose shutdown uses
  it.
- The changed-file style audit identifies hidden factory defaults, a 54-line unsegmented
  construction block, repeated `unknown` double assertions, line-width debt, a pass-through clock
  candidate, and nested callback pressure in the two owning files.

The verified repository consumers of `createRallarServer` are API-v1 `main.ts`, the Relic server,
API-v1 tests, and active documentation. `apps/api-v1/deno.json` exports no package surface.

## Selected approach

Use two independently testable slices:

1. Establish the explicit database, default, lifecycle, and runtime boundary; migrate every
   service-locator consumer; and remove the optional factory and global runtime path.
2. Extract the already-explicit topology, admin, system-installer, and route-installer phases from
   the canonical server factory.

This is narrower than a full API-v1 tree rewrite and stronger than extracting private helpers while
leaving the same mixed owners. Each new module must own a real construction, lifecycle, route,
translation, or side-effect boundary. A module that only forwards an unchanged dependency bundle is
not part of the target shape.

## Compatibility decision

The maintainer approved migrating every known repository consumer from the optional default call
shape to an explicit default factory:

```ts
createDefaultRallarServer();
createDefaultRallarServer({ ws });
```

`createRallarServer(input)` becomes the required-input canonical assembly function. The existing
optional `CreateRallarServerOptions`, app-local middleware service locator, app-local state-service
getters, and alternate default construction paths are removed. No compatibility wrapper, deprecated
export, dual construction path, or fallback is retained.

This decision does not approve changes to shared-server package exports, REST or OpenAPI contracts,
WebSocket protocol or topic contracts, persisted formats, AppInbox transaction and retry behavior,
runtime readiness, queue semantics, or public Rallar facade behavior. Discovery of a verified
external or package-level consumer that current repository searches cannot see is a new
compatibility decision and stops implementation for maintainer direction.

## Target ownership

The target composition area is:

```text
apps/api-v1/src/composition/
  README.md
  api-v1-runtime.ts
  api-v1-background-task-lifecycle.ts
  create-api-v1-runtime.ts
  create-api-v1-mutation-runtime.ts
  create-api-v1-topology-services.ts
  create-api-v1-admin-services.ts
  create-api-v1-system-installers.ts
  create-api-v1-route-installers.ts
  create-rallar-server.ts
  create-default-rallar-server.ts
```

The structure is an ownership target, not an instruction to preserve an unnecessary file. During
implementation, a proposed module stays separate only when its direct callers, inputs, result, and
reason to change remain independently meaningful after the code is moved.

### `api-v1-runtime.ts`

Owns the canonical `ApiV1Runtime` contract and the fail-closed conversion from the shared
`RallarMiddlewareRuntime` result to the API-specific complete runtime. The current generic
`Middleware` name and `middleware-contract.ts` disappear.

`ApiV1Runtime` retains the complete current API middleware contract: cached client and group state
services; RTC publication, execution, delivery, and replay; auth AppInbox; client and group REST
snapshot selectors; group formation metrics; repositories; queues; WebSocket QueueBox; readiness;
and health failure. It adds one mandatory `backgroundTasks: ApiV1BackgroundTaskLifecycle`
capability. The implementation plan spells out that complete contract and does not use an open index
signature or a rename-only alias.

### `api-v1-background-task-lifecycle.ts`

Owns background stop registration, runtime-state expiry startup generations, and shutdown. It
replaces module-global `backgroundTaskStops` and `runtimeStateExpiryLifecycle` values with one
explicit lifecycle created for one default API runtime.

The capability has three operations:

```ts
export interface ApiV1BackgroundTaskLifecycle {
  beginStartupGeneration(): RuntimeStateExpiryStartupGeneration;
  register(stop: () => void | Promise<void>): () => void;
  stop(): Promise<void>;
}
```

The startup-generation result uses the existing canonical `RuntimeStateExpiryStartupGeneration` type
directly.

`stop()` snapshots the registered stops, clears ownership before awaiting them, stops the expiry
lifecycle, invokes every captured stop, and exposes failure to its caller. Repeated stop is safe.

### `create-api-v1-runtime.ts`

Owns visible top-to-bottom API runtime construction from required dependencies. It reads no hidden
database singleton and contains no production defaults. It creates the existing RTC runtime through
`createApiRtcTopologyRuntime`, calls the mutation-runtime owner, calls `createRallarMiddleware`,
attaches replay after the middleware exists, starts explicitly owned startup work, creates snapshot
selectors, and returns a complete `ApiV1Runtime`.

### `create-api-v1-mutation-runtime.ts`

Owns the cohesive mutation-runtime inputs required by `createRallarMiddleware`: QueueBox and inbox
repositories, durable and cached client/group state services, auth credentials and repositories,
AppInbox factory callbacks, CRDT mutation factories, retry-exhaustion behavior, and presence-summary
outbox registration.

It does not open, commit, or retry an AppInbox transaction. Existing shared-server AppInbox owners
retain transaction, retry, conflict, receipt, event, durable result, and final outbox behavior.

### `create-api-v1-topology-services.ts`

Owns API-v1 topology and RTT composition: topology configuration, group state, topology snapshot and
RTT repositories; the supported `RallarRtcTopologyService`; refinement gate and service; topology
management; topology admin metrics; group AppInbox topology installation; and RTT policy-input
wiring.

It delegates graph calculation, snapshot planning, runtime delivery, replay, persistence, and RTT
refinement decisions to their existing canonical shared-server owners.

### `create-api-v1-admin-services.ts`

Constructs `AdminOperationsService`, `AdminSupportService`, and `SpaStatisticsService` from explicit
runtime, topology, repository, database, timing, identity, configuration, and clock dependencies. It
receives a direct `readApiV1WebSocketStatus` capability over the already-constructed runtime. This
eliminates the current `rallarApplication` forward capture and the local empty status fallback.

The API-local status reader is a boundary projection from the runtime WebSocket server's current
connections into the existing `RallarServerWsStatus` contract. It contains no connection policy or
state and does not introduce another WebSocket owner.

### `create-api-v1-system-installers.ts`

Creates the default system-topic and WebSocket-lifecycle installers from already-constructed
runtime, topology, CRDT, retry, and background-lifecycle capabilities. Topic and lifecycle cleanup
is registered only when the corresponding installer is invoked. Existing idempotency remains owned
by `RallarServerSystemFacade`.

### `create-api-v1-route-installers.ts`

Creates the WebSocket and REST installer inventory from explicit auth, state, topology, admin,
statistics, repository, and runtime dependencies. It performs no service construction, environment
read, database adaptation, or hidden defaulting.

Affected route files receive required dependencies through named route contracts. Generic exported
`init` names in materially touched route files are renamed to behavior-named `registerXxxRoutes`
functions. Untouched independent route files remain outside the closure.

### `create-rallar-server.ts`

Owns only final required-input application assembly:

```ts
export interface ApiV1RouteInstallers {
  readonly ws: RallarServerRouteInstaller<Hono>;
  readonly rest: readonly RallarServerRouteInstaller<Hono>[];
}

export interface CreateRallarServerInput {
  readonly runtime: ApiV1Runtime;
  readonly repositories: RepositoryManager;
  readonly appDataRepository: AppDataRepositoryLike;
  readonly ws: RallarServerWsFacadeOptions;
  readonly systemInstallers: RallarServerSystemInstallers<ApiV1Runtime>;
  readonly routeInstallers: ApiV1RouteInstallers;
}

export function createRallarServer(
  input: CreateRallarServerInput,
): RallarServerApplication<ApiV1Runtime, Hono>;
```

Topology, admin, CRDT, and statistics services are already represented by the supplied installers.
The canonical factory contains no environment reads, default selection, SQL assertion, service
locator, service construction, or callback that captures a value assigned later.

### `create-default-rallar-server.ts`

Owns all production default selection. It reads validated configuration, gets the raw API SQL
client, normalizes that client once to `PSqlSql`, creates the background lifecycle, runtime,
topology services, admin services, installers, default repository manager and app-data repository,
then calls `createRallarServer`.

The only consumer customization retained by this default factory is the intentional WebSocket
configuration used by the Relic server:

```ts
export interface CreateDefaultRallarServerOptions {
  readonly ws?: RallarServerWsFacadeOptions;
}

export function createDefaultRallarServer(
  options?: CreateDefaultRallarServerOptions,
): RallarServerApplication<ApiV1Runtime, Hono>;
```

Absence of `ws` means the existing default WebSocket configuration. Tests that replace runtime,
repository, audit, app-data, clock, topology, or configuration dependencies use the canonical
required-input owners rather than expanding these default options.

## SQL boundary

`apps/api-v1/src/db/to-p-sql-sql.ts` owns the one supported translation:

```ts
export function toPSqlSql(sqlClient: ApiV1Sql): PSqlSql;
```

Every supported `ApiV1Sql` implementation already implements the callable and transaction contract
required by shared-server Postgres repositories. The function performs one explicit boundary
assertion and returns the same object identity. It does not validate a network connection, select a
backend, wrap queries, or change transaction behavior.

Below this boundary, API composition imports the canonical shared-server repository factories and
passes `PSqlSql` directly. The app-local `repository/create-state-repositories.ts` wrapper is
deleted because its seven exports only forwarded identical inputs and outputs to those canonical
owners. Shared factories that also accept an already-created `RuntimeStateRepositoryLike` retain
that genuine union. Raw Postgres.js-specific notification or lifecycle consumers continue to use
their explicit raw SQL client boundary and do not flow through domain repository construction.

The former `repository/login-repository.ts` path is moved to `services/api-login-service.ts`. It
owns login and registration request policy plus the static-client configuration boundary; it does
not own persistence and therefore does not belong in a repository subtree.

## Construction and registration timeline

The default construction timeline is:

1. Read and validate database, pub/sub, topology, formation, capacity, identity, timing, and other
   existing operational configuration.
2. Resolve the raw API SQL client and translate it once to `PSqlSql`.
3. Create one `ApiV1BackgroundTaskLifecycle` and begin one startup generation.
4. Create QueueBox, inbox/result repositories, runtime-state repositories, caches, auth
   repositories, credential issuer, timing, metrics, and mutation-runtime factory capabilities.
5. Create the existing RTC topology runtime and queue pub/sub bridge.
6. Call `createRallarMiddleware` with fully constructed dependencies.
7. Attach topology replay to the completed WebSocket QueueBox service.
8. Register process-owned RTC, scalar recompute, expiry, and reconciliation background work.
9. Create API snapshot selectors and require the complete `ApiV1Runtime` shape.
10. Create topology and RTT composition services and install their group AppInbox dependencies.
11. Create the direct WebSocket status reader, admin services, system installers, and route
    installers.
12. Call required-input `createRallarServer`.
13. The caller invokes default-topic and WebSocket-lifecycle installation, mounts routes, binds the
    HTTP listener, waits for runtime readiness, then starts queue workers under the existing replay
    policy.

Every dependency exists before its consumer. No setter, service locator, definite-assignment
assertion, mutable forward capture, supplier introduced only for late lookup, or test-only factory
hides construction order.

## Runtime invocation and shutdown

Request and WebSocket callbacks capture required capabilities supplied by route and system
installers. They do not call `getMiddleware`, `getClientStateService`, `getGroupStateService`, or
`getWsStateSyncPublisher`.

The runtime invocation families remain:

- REST reads use the same auth, cached/durable state, topology, admin, and response owners.
- REST and WebSocket mutations enter the same AppInbox services and retain their complete
  read/compute/validate/write, transaction, retry, commit, after-commit, durable-result, and final
  outbox paths.
- Default system topics call the same shared-server topic installers and topology capabilities.
- WebSocket lifecycle cleanup enqueues the same client disconnect and group-session cleanup
  mutations with the same retry schedule.
- State-sync publication uses the constructed runtime WebSocket QueueBox service and the same
  canonical server identity.

`main.ts` and health-failure shutdown call `rallar.runtime.backgroundTasks.stop()`. The lifecycle
stops its expiry generation and invokes all stop callbacks captured at that moment. Topic or
WebSocket lifecycle cleanup unregisters itself before invoking its owned stop operation, preserving
the current no-double-stop behavior. Failure remains visible to the caller, which retains the
existing logging and step-failure policy.

## Service-locator removal map

The implementation migrates these current paths to explicit dependencies:

- `services/request-auth-service.ts`: auth repository, auth AppInbox capability, request ID, and
  clock are supplied through named inputs or a constructed auth boundary.
- `routes/client-state-routes.ts`: client state and client AppInbox dependencies are required route
  inputs.
- `group-state/create-group-state-route-dependencies.ts`: group state and group AppInbox
  dependencies are required from route composition.
- `routes/graph-topology-routes.ts`: group state, topology management, and group AppInbox are
  required inputs.
- `routes/config-route.ts`: auth AppInbox is a required input.
- `routes/ws-routes.ts`: socket, client AppInbox, and group AppInbox dependencies are required
  inputs.
- `services/state-sync-service.ts`: the WebSocket QueueBox service is supplied to the canonical
  publisher factory; the getter disappears.
- `services/client-state-service.ts` and `services/group-state-service.ts`: app-local default getter
  constructors disappear when no verified consumer remains. Shared-server service factories remain
  exported from their canonical owners.
- `apps/relic-hunter-server-v1`: reads the already-constructed runtime group state service rather
  than constructing an independent service through an API-v1 getter.

Optional route dependency contracts remain optional only where tests or reusable route composition
have a genuine absence/default meaning. A dependency that production always requires becomes
required; tests use the same port with a fake.

## Failure behavior

The refactor preserves these observable failure boundaries:

- Invalid operational configuration and missing required secrets fail synchronously during default
  construction.
- Missing required AppInbox services fail before admin, route, or topic construction.
- The SQL boundary has one canonical path and no fallback, retry, or backend guess.
- Repository, queue, RTC runtime, and service constructor errors propagate from the owning
  construction phase.
- System-topic and WebSocket-lifecycle installation errors surface when the caller invokes the
  installer.
- Route decoding, authorization, expected failures, and response translation remain owned by the
  current route/domain code.
- Detached best-effort expiry, cleanup, and reconciliation startup retains its current bounded
  logging behavior.
- Runtime readiness rejection prevents queue-worker startup after HTTP binding, as it does today.
- Shutdown invokes every captured stop and exposes rejection to the caller; the API health-shutdown
  owner retains its existing per-step failure reporting.

The implementation must preserve exception timing where a moved call can throw. Characterization
tests establish construction and installer order before production relocation.

## Testing design

Tests mirror the composition owners:

```text
apps/api-v1/test/composition/
  api-v1-background-task-lifecycle.test.ts
  create-api-v1-runtime.test.ts
  create-rallar-server.test.ts
  create-default-rallar-server.test.ts
  create-api-v1-system-installers.test.ts
  create-api-v1-route-installers.test.ts
```

The implementation plan may consolidate test files when one semantic fixture and one control-flow
family make that easier to follow. It must not create a source-file inventory or exact-tree ratchet.

Primary semantic tests prove:

- required dependencies exist before consumer construction;
- the normalized `PSqlSql` value keeps the raw client's object identity and is the one supplied to
  repository and runtime owners;
- no lower production owner receives an unnormalized SQL union;
- the canonical required factory mounts the same WebSocket and REST behavior;
- default topics and WebSocket lifecycle remain idempotent;
- AppInbox remains the only incoming mutation ingress;
- runtime readiness precedes queue-worker startup;
- topic, lifecycle, startup, readiness, and shutdown failures retain their timing and propagation;
- shutdown attempts every registered stop and repeated stop is safe;
- WebSocket status reads current runtime connections without a forward capture;
- API and Relic consumers use the canonical default construction path; and
- tests replace dependencies through production ports, not an alternate test-only factory.

The existing broad `apps/api-v1/test/rallar-server.test.ts` is split by behavior. Observable route,
topic, lifecycle, game-authority, and CRDT assertions remain. Assertions coupled only to private
file topology are replaced or removed.

## Validation design

Focused validation runs first:

```bash
cd apps/api-v1
deno test --allow-env --allow-read --allow-write test/composition test/rallar-server.test.ts
deno task check
deno task lint
```

Consumer validation includes:

```bash
cd apps/relic-hunter-server-v1
deno task check
deno task test
```

Repository review includes:

```bash
npm run check:repo-style
npm run check:repo-style:construction-details -- --root apps/api-v1/src
npm run check:repo-style:changed -- 04615706883bef612cdf40f13e488a98644b8710
npm run check:repo-structure -- --base 04615706883bef612cdf40f13e488a98644b8710
npm run test:repo-structure
npm run review:legacy -- 04615706883bef612cdf40f13e488a98644b8710 HEAD
```

API behavior validation includes:

```bash
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
```

The implementation plan re-authenticates this exact base before execution. If `main` moves before
implementation begins, it records the newly resolved exact merge base and uses that full commit ID
in these three commands. Deno formatting covers app-owned TypeScript and Markdown formatting uses
the repository Prettier command.

The state-write comparative performance gate is activated only if implementation evidence changes a
mutation path or concurrency domain. A pure construction relocation makes no new performance claim
and does not create a new benchmark.

## Touched-file standards closure

Every changed human-authored source, test, documentation, fixture, script, example, or configuration
file is reviewed and remediated in full. Every support file modified by that remediation enters
closure recursively until no changed human-authored file remains outside closure. Independent
untouched code remains outside closure.

The two broad owning files cannot retain pre-existing line-width, hidden-default, construction,
callback, generic-name, type-organization, or responsibility noncompliance merely because those
findings predate this work. A materially touched route file closes its own applicable route,
dependency, naming, line-width, function-size, type, and construction findings. This deterministic
closure may expand the changed surface but does not create a third active slice.

Every construction-detail warning in changed production receives a path, rule, symbol, and human
disposition. Automation tolerance is evidence, not authority to retain noncompliance.

## Affected production legacy

The expected affected legacy dispositions are:

- optional `CreateRallarServerOptions`: `removed`;
- `createRallarServer()` default overload behavior: `removed` after consumer migration;
- module-global middleware storage and `getMiddleware`: `removed`;
- app-local state and state-sync getter constructors: `removed` when their verified consumers
  migrate;
- repeated `as unknown as PSqlSql` composition assertions: `resolved` at one named SQL boundary;
- forward-captured `rallarApplication` WebSocket status callback: `resolved` through direct runtime
  status projection;
- module-global background-task registry: `removed` in favor of runtime-owned lifecycle;
- generic materially touched route `init` exports: `resolved` with behavior-named registration.

The final code review traces every changed production path and classifies all additional affected
legacy as `removed`, `minimized-boundary`, `resolved`, or `retained`. Retention requires a new exact
maintainer approval and durable registry entry; an issue or passing check does not authorize it.

## Navigation

`apps/api-v1/src/composition/README.md` is the durable read-first map. It documents:

- API and Relic entry points;
- default construction order;
- required canonical assembly;
- route and system-installer registration;
- background task registration, invocation, and shutdown;
- failure boundaries; and
- direct links to the runtime, mutation, topology, admin, installer, and route owners.

Completion includes a cold code-only navigation review from both `apps/api-v1/src/main.ts` and
`apps/relic-hunter-server-v1/src/main.ts` to the returned `RallarServerApplication`. The reviewer
does not use this design, the implementation plan, a file inventory, or Git history as the map.

## Non-goals

- No REST, OpenAPI, WebSocket protocol, route result, persistence, AppInbox, retry, topology
  algorithm, CRDT, auth, state, or admin behavior redesign.
- No operational configuration-source migration to JSON in this slice.
- No shared-server package export change.
- No new package, process, deployable service, service locator, compatibility wrapper, or nested
  barrel.
- No repository-wide style cleanup, route rename, SQL rewrite, or formatter run.
- No new performance optimization, benchmark, or numeric performance claim.

## Acceptance criteria

- `createDefaultRallarServer` visibly owns defaults and calls required-input `createRallarServer`.
- Every supported repository and runtime owner receives the same once-normalized `PSqlSql` client.
- `ApiV1Runtime` and its background lifecycle have one explicit construction and shutdown owner.
- No `getMiddleware`, module-global runtime, repeated composition SQL double assertion, app-local
  alternate state-service constructor, or forward-captured server application remains in the
  affected path.
- Routes, topics, startup, readiness, shutdown, AppInbox, persistence, and public Rallar application
  behavior remain semantically equivalent.
- API-v1 and Relic consumers compile and run through the default factory.
- Every changed file completes touched-file standards closure and every affected legacy item has a
  final disposition.
- Focused semantic tests, API and Relic checks, style/structure/format review, medium-scale API
  behavior, and topology replay pass or report an exact classified blocker.
- Actual bugs are tested and fixed; every other confirmed weakness has an accurate existing or new
  GitHub issue URL.
- A cold code-only reviewer can trace both application entries to construction, registration,
  runtime invocation, failures, and shutdown without a wrong-file guess or hidden lookup.

## Local delivery boundary

This design and its implementation plan are prepared locally on a non-default branch. Planning
creates no push or pull request. Implementation publication remains a later explicit user decision.
