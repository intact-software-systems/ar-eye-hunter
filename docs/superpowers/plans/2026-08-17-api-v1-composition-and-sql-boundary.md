# API-v1 Composition And SQL Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #237 by making API-v1 default construction, required assembly, SQL
normalization, runtime ownership, route dependencies, and background-task lifecycle explicit while
preserving API, WebSocket, AppInbox, persistence, and topology behavior.

**Architecture:** Use two independently testable slices. Slice 1 introduces one SQL translation,
runtime-owned lifecycle, complete API runtime construction, and explicit route/service dependencies;
Slice 2 extracts topology, admin, system, route, canonical application, and production-default
composition owners, then migrates API-v1 and Relic consumers. The final tree has one default entry,
one required canonical factory, no service locator, and no compatibility wrapper.

**Tech Stack:** TypeScript with `erasableSyntaxOnly`, Deno 2, Hono, Postgres.js/PGlite,
`@shared-server` Rallar facades and AppInbox services, Node/npm repository checks, Markdown.

**Design:** `docs/superpowers/specs/2026-08-17-api-v1-composition-and-sql-boundary-design.md`

**Issue:** [#237](https://github.com/intact-software-systems/ar-eye-hunter/issues/237)

**Draft PR:** [#257](https://github.com/intact-software-systems/ar-eye-hunter/pull/257)

**Exact execution base:** `04615706883bef612cdf40f13e488a98644b8710` (2026-08-17). Before production
edits, fetch `origin/main`, verify that this remains the merge base, and amend only the base and
validation commands if a material main change alters the design.

## Global Constraints

- Preserve REST paths, OpenAPI behavior, WebSocket topics and lifecycle, AppInbox mutation ingress,
  transaction/retry/receipt/outbox behavior, persistence formats, RTC topology behavior, readiness,
  queue-worker startup, health shutdown, and Rallar facade behavior.
- The approved compatibility decision is final for this work: migrate known consumers to
  `createDefaultRallarServer`, make `createRallarServer(input)` required, and retain no overload,
  deprecated export, fallback, or compatibility wrapper.
- Normalize `ApiV1Sql` to `PSqlSql` once in default composition. Below that translation, repository
  and runtime owners accept `PSqlSql` or a genuine `RuntimeStateRepositoryLike`, never raw `Sql`, a
  hidden singleton default, or an `as unknown as` assertion.
- Construct every dependency before its consumer. Do not introduce a setter, definite-assignment
  assertion, forward capture, supplier used only for late lookup, module global, service locator,
  test-only factory, or pass-through facade.
- Keep AppInbox as the only incoming authoritative mutation path. This refactor does not move,
  duplicate, or weaken transaction, retry, conflict, receipt, event, durable-result, or final-outbox
  ownership.
- Preserve throwable call order and callback timing. Write characterization tests before moving a
  construction, installation, readiness, or shutdown boundary that can throw.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- Resolve all affected production legacy as `removed`, `minimized-boundary`, `resolved`, or
  `retained`. A retained item requires new exact maintainer approval and a durable registry entry;
  an issue or passing check is not authority.
- If an actual bug is found, first add a semantic test that fails for the bug, then implement the
  minimal fix. Search existing issues before creating a focused issue for any other confirmed code
  or performance weakness.
- Publish only coherent commits to PR #257. Update its Goal, Changes, Acceptance, Validation, Risk
  and rollback, and Follow-up sections after each completed task; do not add machine metadata or a
  progress ledger.

## Working-plan slices

Only these two slices are concrete:

1. **Explicit SQL, lifecycle, runtime, and request ownership:** introduce the database translation,
   required repository inputs, runtime-owned background lifecycle, complete `ApiV1Runtime`, explicit
   runtime construction, explicit auth/state/route dependencies, and remove the module-global
   middleware path.
2. **Explicit server composition and consumer closure:** extract topology, admin, system, and route
   construction; create required `createRallarServer` and default `createDefaultRallarServer`;
   migrate API-v1 and Relic; update navigation; complete validation and legacy review.

New evidence that changes behavior, ownership, compatibility, or validation risk amends this plan
before more production work. Do not activate a third slice.

## Locked target structure

### Composition owners

- Create: `apps/api-v1/src/composition/api-v1-runtime.ts` — complete API runtime contract and
  fail-closed conversion from `RallarMiddlewareRuntime`.
- Create: `apps/api-v1/src/composition/api-v1-background-task-lifecycle.ts` — one runtime's stop
  registry and runtime-state expiry startup generations.
- Create: `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts` — QueueBox, repository,
  cache, auth, AppInbox-factory, CRDT-factory, retry-exhaustion, and presence-summary wiring.
- Create: `apps/api-v1/src/composition/create-api-v1-runtime.ts` — RTC runtime, shared middleware,
  replay attachment, startup work, selectors, and complete API runtime construction.
- Create: `apps/api-v1/src/composition/create-api-v1-topology-services.ts` — topology/RTT service,
  repository, refinement, AppInbox dependency, and management composition.
- Create: `apps/api-v1/src/composition/create-api-v1-admin-services.ts` — admin operations, support,
  statistics, and direct runtime WebSocket status projection.
- Create: `apps/api-v1/src/composition/create-api-v1-system-installers.ts` — default topic and
  WebSocket lifecycle installers.
- Create: `apps/api-v1/src/composition/create-api-v1-route-installers.ts` — explicit WebSocket and
  REST installer inventory.
- Create: `apps/api-v1/src/composition/create-rallar-server.ts` — required-input application
  assembly only.
- Create: `apps/api-v1/src/composition/create-default-rallar-server.ts` — operational defaults,
  configuration reads, one SQL translation, and full top-to-bottom default composition.
- Create: `apps/api-v1/src/composition/README.md` — read-first construction, registration,
  invocation, failure, and shutdown map.

### Database boundary

- Create: `apps/api-v1/src/db/to-p-sql-sql.ts` — `ApiV1Sql` to `PSqlSql` translation.
- Delete after consumer migration: `apps/api-v1/src/repository/create-state-repositories.ts` — the
  app-local exports only duplicate canonical shared-server repository factories.
- Move/modify: `apps/api-v1/src/services/api-login-service.ts` — explicit auth repository,
  static-client policy, clock, and identity inputs under its real request-policy owner.

### Explicit route and service dependencies

- Modify: `apps/api-v1/src/services/request-auth-service.ts` — retain stateless auth operations but
  require repository/AppInbox/facts at every call.
- Delete after consumer migration: `apps/api-v1/src/services/client-state-service.ts`,
  `apps/api-v1/src/services/group-state-service.ts`, and
  `apps/api-v1/src/services/state-sync-service.ts`.
- Modify and split when required by touched-file closure: `routes/config-route.ts`,
  `routes/ws-routes.ts`, `routes/client-state-routes.ts`, `routes/graph-topology-routes.ts`,
  `routes/ice-route.ts`, `routes/spa-statistics-routes.ts`, `routes/crdt-admin-routes.ts`, and
  `group-state/create-group-state-route-dependencies.ts`.
- Modify: `routes/create-state-snapshot-read-route-registrars.ts` and
  `group-state/group-state-route-contracts.ts` to use already-constructed direct services.
- Delete after route composition absorbs it: `create-rallar-admin-route-initializers.ts`.

### Retired broad owners

- Delete after transfer and consumer migration: `apps/api-v1/src/initialise-middleware.ts`,
  `apps/api-v1/src/middleware-contract.ts`, `apps/api-v1/src/middleware-background-tasks.ts`, and
  `apps/api-v1/src/create-rallar-server.ts`.

### Consumers and documentation

- Modify: `apps/api-v1/src/main.ts`.
- Modify: `apps/relic-hunter-server-v1/src/main.ts`.
- Modify current navigation: `apps/api-v1/README.md`, `docs/environment-variables.md`, and
  `packages/shared-server/rallar-server-repositories.md`.
- Update semantic tests under `apps/api-v1/test/**` and relevant repository-governance fixtures only
  when their independent contract still applies.

---

## Slice 1: Explicit SQL, lifecycle, runtime, and request ownership

### Task 1: Authenticate the base and establish the SQL boundary

**Files:**

- Create: `apps/api-v1/src/db/to-p-sql-sql.ts`.
- Create: `apps/api-v1/test/composition/api-v1-sql-boundary.test.ts`.
- Keep repository signatures unchanged until Task 4 migrates every direct consumer in the same
  coherent commit.

**Interfaces:**

- Consumes: `ApiV1Sql`, `PSqlSql`, and `RuntimeStateRepositoryLike`.
- Produces:

```ts
export function toPSqlSql(sqlClient: ApiV1Sql): PSqlSql;
```

- [x] **Step 1: Verify current identity and baseline**

Run:

```bash
git fetch origin main --prune
git merge-base HEAD origin/main
git status --short
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write test/rallar-server.test.ts
```

Expected: merge base `04615706883bef612cdf40f13e488a98644b8710`, clean tracked state, API check exit
0, server suite 4 passed/0 failed. If the merge base differs, inspect the material main delta before
editing and record the new exact base in this plan and PR.

- [x] **Step 2: Write the failing identity test**

Create a callable fake with a `begin` method and assert that translation preserves object identity:

```ts
Deno.test('toPSqlSql preserves the supported API SQL client identity', () => {
  const database = Object.assign(
    function <T>(_strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> {
      return Promise.reject(new Error('query not used'));
    },
    {
      begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
        return Promise.reject(new Error('transaction not used'));
      },
    },
  ) as PSqlSql;
  const sqlClient: ApiV1Sql = database;

  assert.equal(toPSqlSql(sqlClient), database);
});
```

- [x] **Step 3: Run RED**

Run:

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition/api-v1-sql-boundary.test.ts
```

Expected: fail because `src/db/to-p-sql-sql.ts` does not exist.

- [x] **Step 4: Implement the single translation**

Use one boundary assertion, never a double assertion:

```ts
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { ApiV1Sql } from './db.ts';

export function toPSqlSql(sqlClient: ApiV1Sql): PSqlSql {
  return sqlClient as PSqlSql;
}
```

Do not change repository inputs in this task. Task 4 migrates those signatures and all consumers
together, after explicit route dependencies exist.

- [x] **Step 5: Run GREEN and the app type-check**

Run:

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition/api-v1-sql-boundary.test.ts
cd apps/api-v1 && deno task check
```

Expected: identity test passes and API check exits 0.

- [x] **Step 6: Review, commit, push, and update PR #257**

Run Deno format only over changed API files, inspect every changed file in full, run
`git diff --check`, stage exact Task 1 paths, and commit:

```bash
git commit -m "refactor(api-v1): normalize the SQL boundary once"
git push
```

Update PR Validation with the exact RED/GREEN and type-check results.

### Task 2: Move background-task ownership into the API runtime

**Files:**

- Create: `apps/api-v1/src/composition/api-v1-background-task-lifecycle.ts`.
- Create: `apps/api-v1/test/composition/api-v1-background-task-lifecycle.test.ts`.
- Keep unchanged in this task: `services/runtime-state-expiry-startup.ts`.
- Delete after all callers migrate in Task 4: `middleware-background-tasks.ts`.

**Interfaces:**

```ts
export interface ApiV1BackgroundTaskLifecycle {
  beginStartupGeneration(): RuntimeStateExpiryStartupGeneration;
  register(stop: () => void | Promise<void>): () => void;
  stop(): Promise<void>;
}

export interface CreateApiV1BackgroundTaskLifecycleInput {
  readonly runtimeStateExpiry: RuntimeStateExpiryLifecycle;
}

export function createApiV1BackgroundTaskLifecycle(
  input: CreateApiV1BackgroundTaskLifecycleInput,
): ApiV1BackgroundTaskLifecycle;
```

- [x] **Step 1: Write lifecycle RED tests**

The tests use a fake `RuntimeStateExpiryLifecycle` and prove:

```ts
Deno.test(
  'background lifecycle unregisters one stop and attempts every remaining stop',
  async () => {
    const calls: string[] = [];
    const lifecycle = createApiV1BackgroundTaskLifecycle({
      runtimeStateExpiry: createFakeRuntimeStateExpiryLifecycle(calls),
    });
    const unregister = lifecycle.register(() => calls.push('removed'));
    lifecycle.register(() => calls.push('first'));
    lifecycle.register(() => {
      calls.push('second');
      throw new Error('second failed');
    });

    unregister();
    await assert.rejects(() => lifecycle.stop(), /second failed/);
    assert.deepEqual(calls, ['expiry-stop', 'first', 'second']);
  },
);

Deno.test('background lifecycle is repeat-stop safe and starts a fresh generation', async () => {
  const calls: string[] = [];
  const lifecycle = createApiV1BackgroundTaskLifecycle({
    runtimeStateExpiry: createFakeRuntimeStateExpiryLifecycle(calls),
  });
  const firstGeneration = lifecycle.beginStartupGeneration();
  const secondGeneration = lifecycle.beginStartupGeneration();
  assert.notEqual(firstGeneration, secondGeneration);

  lifecycle.register(() => calls.push('task-stop'));
  await lifecycle.stop();
  await lifecycle.stop();

  assert.deepEqual(calls, ['begin', 'begin', 'expiry-stop', 'task-stop']);
});
```

Define `createFakeRuntimeStateExpiryLifecycle` in the test file as a complete
`RuntimeStateExpiryLifecycle`: `beginStartupGeneration` appends `begin` and returns a new object
with the three required generation operations; both start operations resolve `0`; `stop` appends
`expiry-stop` only on its first call. This keeps the assertions semantic without reading source.

- [x] **Step 2: Run RED**

Run the new test file. Expected: missing composition lifecycle module.

- [x] **Step 3: Implement lifecycle ownership**

Use a private `Set<() => void | Promise<void>>`. `stop()` snapshots and clears the set before
awaiting, stops runtime-state expiry before invoking captured callbacks, starts every callback via
`Promise.all`, and is idempotent. `register` returns an unregister function whose body performs the
delete without returning the Set boolean.

- [x] **Step 4: Run GREEN and existing expiry tests**

Run:

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition/api-v1-background-task-lifecycle.test.ts \
  test/services/runtime-state-expiry-startup.test.ts
```

Replace the existing source-text assertions about `middleware.ts` and
`middleware-background-tasks.ts` with semantic lifecycle assertions. Do not introduce a new
source-file inventory.

- [x] **Step 5: Review, commit, push, and update PR #257**

Commit:

```bash
git commit -m "refactor(api-v1): own background work in the runtime"
git push
```

### Task 3: Define the complete API runtime and explicit mutation composition

**Files:**

- Create: `apps/api-v1/src/composition/api-v1-runtime.ts`.
- Create: `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts`.
- Create: `apps/api-v1/test/composition/api-v1-runtime.test.ts`.
- Create: `apps/api-v1/test/composition/create-api-v1-mutation-runtime.test.ts`.
- Keep app-local repository and login signatures unchanged until Task 4 can migrate every direct
  production and test consumer atomically.

**Interfaces:**

```ts
export interface ApiV1Runtime extends Omit<
  RallarMiddlewareRuntime,
  | 'clientStateService'
  | 'groupStateService'
  | 'rtcTopologyPublicationRepository'
  | 'rtcTopologyExecutionRepository'
  | 'rtcTopologyDelivery'
  | 'rtcTopologyReplay'
  | 'appAuthInboxService'
> {
  readonly clientStateService: CachedClientStateService;
  readonly groupStateService: CachedGroupStateService;
  readonly rtcTopologyPublicationRepository: RtcTopologyPublicationRepository;
  readonly rtcTopologyExecutionRepository: RtcTopologyExecutionRepository;
  readonly rtcTopologyDelivery: NonNullable<RallarMiddlewareRuntime['rtcTopologyDelivery']>;
  readonly rtcTopologyReplay: NonNullable<RallarMiddlewareRuntime['rtcTopologyReplay']>;
  readonly appAuthInboxService: AppAuthInboxService;
  readonly authSessionRepository: AuthSessionRepository;
  readonly clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
  readonly groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
  readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
}
```

`requireApiV1Runtime` receives the shared runtime plus the auth repository, selectors, metrics, and
background lifecycle as required named inputs. It preserves the existing fail-closed checks and adds
no open index signature or rename alias.

`createApiV1MutationRuntime` owns the existing QueueBox/repository/cache/auth/AppInbox factory
construction and returns the complete named inputs consumed by `createRallarMiddleware`; it does not
open or retry an AppInbox transaction.

- [x] **Step 1: Write runtime contract RED tests**

Port the existing `requireApiMiddleware` success and missing-capability cases into
`api-v1-runtime.test.ts`. Add assertions for required `authSessionRepository` and `backgroundTasks`,
and prove the returned object preserves the shared runtime's service identities.

- [x] **Step 2: Write mutation composition characterization tests**

Use fake required repositories and dependencies to prove that the returned AppInbox factories:

- create group/client/auth services only when shared middleware invokes the corresponding factory;
- preserve one database identity across QueueBox, results, AppInbox, presence summary, and retry
  handlers; and
- do not invoke a transaction during composition.

Name the production operation whose change would make each assertion fail before writing it.

- [x] **Step 3: Run RED**

Run both new files. Expected: missing runtime and mutation-composition modules.

- [x] **Step 4: Implement the runtime contract and mutation owner**

Move the cohesive QueueBox, repositories, caches, auth credential issuer, AppInbox factory
callbacks, CRDT factories, resilience, retry telemetry, and group-presence-summary wiring from
`middleware.ts` without changing their order or deferred invocation semantics. Keep operational
defaults out of the factory input; pass database, configuration, identities, timing, clock, secret,
and lifecycle as required values.

- [x] **Step 5: Run GREEN and relevant auth/repository tests**

Run:

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition/api-v1-runtime.test.ts \
  test/composition/create-api-v1-mutation-runtime.test.ts \
  test/request-auth-service.test.ts
cd apps/api-v1 && deno task check
```

- [x] **Step 6: Review, commit, push, and update PR #257**

Commit:

```bash
git commit -m "refactor(api-v1): make mutation runtime ownership explicit"
git push
```

### Task 4: Construct the API runtime and remove locator-based dependencies

**Files:**

- Create: `apps/api-v1/src/composition/create-api-v1-runtime.ts`.
- Create: `apps/api-v1/test/composition/create-api-v1-runtime.test.ts`.
- Delete: `apps/api-v1/src/repository/create-state-repositories.ts` after direct consumers import
  the canonical shared-server factories.
- Move/modify: `apps/api-v1/src/services/api-login-service.ts`.
- Modify: `services/request-auth-service.ts`.
- Modify/split: `routes/config-route.ts`, `routes/ws-routes.ts`, `routes/client-state-routes.ts`,
  `routes/graph-topology-routes.ts`, `routes/ice-route.ts`, `routes/spa-statistics-routes.ts`,
  `routes/crdt-admin-routes.ts`, `group-state/create-group-state-route-dependencies.ts`,
  `group-state/group-state-route-contracts.ts`, and
  `routes/create-state-snapshot-read-route-registrars.ts`.
- Delete when no verified import remains: app-local client/group/state-sync service files.
- Rename/modify: `initialise-middleware.ts` into the temporary default entry that returns a fresh
  explicit runtime without storing it globally; Task 7 absorbs and deletes this entry.
- Delete after transfer: `middleware-contract.ts` and `middleware-background-tasks.ts`.
- Modify: root `create-rallar-server.ts` only enough to consume `ApiV1Runtime` and its owned
  background lifecycle until Tasks 5-7 move the remaining composition.
- Modify: `main.ts` to stop `rallar.runtime.backgroundTasks` rather than a module-global registry.
- Modify mirrored route/service tests and exact repository-governance fixtures whose independent
  contract still names one of the deleted app-local paths.

**Interfaces:**

`createApiV1Runtime` accepts a complete named input containing normalized database, validated
database/pub-sub/replay/group-formation configuration, runtime identities, auth secret, timing,
clock, and `ApiV1BackgroundTaskLifecycle`. It returns `ApiV1Runtime`.

Route registration functions become behavior-named and receive complete production dependencies:

```ts
export interface RegisterWsRoutesInput {
  readonly socketServer: JsonWebSocketServer;
  readonly appClientInboxService: Pick<AppClientInboxService, 'enqueueAuthorisedWsClientConnect'>;
  readonly requireWsAuthSession: (input: RequireWsAuthSessionInput) => Promise<IssuedAuthSession>;
}

export interface ClientStateRouteDependencies {
  readonly clientStateService: ClientStateRouteService;
  readonly requireApiAuthSession: RequireApiAuthSession;
  readonly hydrateStateSyncSnapshotCaches: HydrateStateSyncSnapshotCaches;
  readonly processClientAppInbox: ProcessClientAppInbox;
  readonly readClientSnapshot: ClientStatePointRead;
}
```

Group, graph, config, ICE, statistics, and CRDT routes use the same rule: direct services and named
operations are required; no production service getter, locator fallback, or unconfigured topology
fallback remains.

The app-local repository owners become required and assertion-free:

```ts
export function createRuntimeStateRepository(database: PSqlSql): PSqlRuntimeStateRepository;

export function createClientStateRepository(
  source: RuntimeStateRepositoryLike | PSqlSql,
): ClientStateRepository;
```

The auth, group, and event repository functions use the same required
`RuntimeStateRepositoryLike | PSqlSql` pattern.

- [x] **Step 1: Write runtime construction and failure-order RED tests**

Characterize the current order around RTC runtime creation, shared middleware construction, replay
attachment, background registration, scalar worker first run, reconciliation startup, selector
creation, and complete runtime validation. Use injected operations that append names and throw at a
selected boundary. Assert both the call sequence and that later phases are not invoked after a
synchronous failure.

- [x] **Step 2: Write explicit route-dependency RED tests**

For WS, config, client, group, graph, ICE, statistics, and CRDT families, add or update semantic
tests that call the production registration function with complete fakes. Prove requests reach the
exact supplied auth, state, AppInbox, topology, socket, and statistics capabilities. Delete tests
that only assert a private fallback import or source filename.

- [x] **Step 3: Run RED**

Run the new runtime test and the focused route tests. Expected failures name missing required
contracts or the still-present locator fallback, not unrelated fixture errors.

- [x] **Step 4: Implement `createApiV1Runtime`**

Move the RTC runtime and startup sequence from `middleware.ts` in the same observable order:

```text
create mutation capabilities
create RTC topology runtime
register RTC stop
configure WS runtime stores
start detached resource-inbox expiry
start runtime-state expiry barrier
create shared Rallar middleware
attach topology replay
create and register scalar recompute worker
start detached presence reconciliation
create snapshot selectors
require complete ApiV1Runtime
```

All callback captures refer only to values constructed earlier. Preserve detached error logging and
first-run behavior exactly.

- [x] **Step 5: Remove the locator from every production path**

Make `requireApiAuthSession` require `AuthSessionRepository`. Make `requireWsAuthSession` require
AppAuthInbox and immutable request facts. Supply those operations from route composition.

Replace:

```ts
getMiddleware().appClientInboxService;
getMiddleware().appGroupInboxService;
getMiddleware().appAuthInboxService;
getMiddleware().wsQBoxServerService;
getClientStateService();
getGroupStateService();
getWsStateSyncPublisher();
```

with direct required capabilities captured by the owning registration function. Remove the app-local
getter modules after `rg` proves no verified consumer remains. Import canonical shared-server types
and factories directly instead of retaining rename-only re-exports.

Remove `postgres.Sql`, `defaultSql`, all default parameters, and all assertions from the app-local
repository path by deleting its pass-through factory file. Import the canonical shared-server
factories directly and pass required normalized inputs. Move the login request policy out of the
repository subtree and refactor `api-login-service.ts` to required inputs:

```ts
export interface LoginInput {
  readonly request: LoginRequest;
  readonly userRepository: AuthUserRepository;
  readonly staticClients: readonly LoginClientData[];
}

export interface RegisterInput {
  readonly request: RegisterRequest;
  readonly staticClients: readonly LoginClientData[];
  readonly capturedAtEpochMs: number;
  readonly clientId: string;
}
```

`login` and `register` consume those complete inputs. Keep `readAuthStaticClientsMode` and export
one explicit `readAuthorisedClients(env)` boundary for default route composition.

- [x] **Step 6: Close each materially touched route file**

Split only where the file owns distinct route families or a handler exceeds 30 lines. Keep request
decoding, auth/policy decisions, AppInbox invocation, response mapping, and error mapping traceable
from each registration entry. Rename generic `init` exports to `registerConfigRoutes`,
`registerWsRoutes`, `registerClientStateRoutes`, `registerGraphTopologyRoutes`, `registerIceRoutes`,
`registerSpaStatisticsRoutes`, and `registerCrdtAdminRoutes`.

Use direct named inputs rather than suppliers. Resolve the current four-parameter topology write
helper and CRDT mutation helper with named input interfaces. Do not alter route paths or response
semantics.

- [x] **Step 7: Run GREEN and Slice 1 validation**

Run focused composition/auth/route tests, then:

```bash
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno task lint
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition \
  test/request-auth-service.test.ts \
  test/config-route-auth-logout.test.ts \
  test/ws-routes.test.ts \
  test/client-state \
  test/group-state \
  test/routes/graph-topology-routes.test.ts \
  test/routes/spa-statistics-routes.test.ts \
  test/routes/crdt-admin-routes.test.ts
```

Expected: all selected tests pass, type-check exits 0, and `rg` finds no production `getMiddleware`,
module-global runtime, app-local service getter, or deleted module import. The existing
`initialiseMiddleware` name may remain only as the temporary default entry consumed by the root
server factory; it must contain no storage or locator and Task 7 deletes it.

Execution correction: app-wide `deno task lint` still reports 30 existing issues in untouched test
files. The exact 53 changed API TypeScript files pass `deno lint` and `deno fmt --check`; the broad
failure is retained as baseline evidence rather than expanding this slice into unrelated test debt.

- [x] **Step 8: Review, commit, push, and update PR #257**

Run focused changed-file style and construction review. Record every construction finding by path,
rule, symbol, and disposition. Commit:

```bash
git commit -m "refactor(api-v1): construct the runtime without a service locator"
git push
```

Update the PR with Slice 1 behavior, validation, affected legacy removals, and any issue URL.

---

## Slice 2: Explicit server composition and consumer closure

### Task 5: Extract topology and admin composition owners

**Files:**

- Create: `composition/create-api-v1-topology-services.ts`.
- Create: `composition/create-api-v1-admin-services.ts`.
- Create: `test/composition/create-api-v1-topology-services.test.ts`.
- Create: `test/composition/create-api-v1-admin-services.test.ts`.
- Move code from the retiring root `create-rallar-server.ts`; do not copy it.

**Interfaces:**

```ts
export interface ApiV1TopologyServices {
  readonly rtcTopologyService: RallarRtcTopologyService;
  readonly rtcTopologyOptions: RallarRtcTopologyServiceOptions;
  readonly topologyManagement: GroupTopologyManagementService;
  readonly topologyConfigRepository: GroupTopologyConfigRepository;
  readonly groupStateRepository: GroupStateRepository;
  readonly topologySnapshotRepository: RtcTopologySnapshotRepository;
  readonly rttRepository: RtcRttRepository;
  readonly rttRefinementGate: RtcRttRefinementGate;
  readonly rttRefinementService: RtcRttRefinementService;
  readonly adminClientIds: readonly string[];
  readonly readRtcTopologyMetrics: () => object;
  readonly resetRtcTopologyMetrics: () => void;
}

export interface ApiV1AdminServices {
  readonly operations: AdminOperationsService;
  readonly support: AdminSupportService;
  readonly statistics: SpaStatisticsService;
}
```

The topology owner keeps the existing combined planning/replay metrics object private and exposes
only its read/reset capabilities to the admin owner. `createApiV1AdminServices` receives those
capabilities plus a direct `readWebSocketStatus` function over the already-created runtime socket.
It never captures a later `RallarServerApplication` and has no empty-status fallback.

- [x] **Step 1: Write topology composition RED tests**

Characterize repository identity, topology service/default option identity, management publisher,
group AppInbox topology installation, RTT policy input selection, and failure propagation. Use the
existing canonical topology classes; assert no graph or persistence algorithm is duplicated.

- [x] **Step 2: Write admin composition RED tests**

Use a runtime with a mutable connection map. Construct admin services, change connections after
construction, and assert operations/support/statistics read the current status. Add a throwing
status reader case and prove the same exception reaches the caller without an empty fallback.

- [x] **Step 3: Run RED, implement by movement, and run GREEN**

Move the existing topology and admin blocks into their owners. Pass `PSqlSql`, runtime,
repositories, clock, timing, identity, and configuration as required inputs. Preserve every callback
body and failure boundary unless a RED characterization proves an existing bug.

Run both new tests, relevant graph/admin route tests, and `deno task check`.

Execution finding: the moved RTT policy callback performs one full retained-presence scan per RTT
command and then reads each candidate group/topology snapshot. The ownership refactor preserves
that behavior; [issue #259](https://github.com/intact-software-systems/ar-eye-hunter/issues/259)
owns measurement and a bounded lookup design without expanding this slice.

- [x] **Step 4: Review, commit, push, and update PR #257**

Commit:

```bash
git commit -m "refactor(api-v1): separate topology and admin composition"
git push
```

### Task 6: Extract system and route installers

**Files:**

- Create: `composition/create-api-v1-system-installers.ts`.
- Create: `composition/create-api-v1-route-installers.ts`.
- Create: `test/composition/create-api-v1-system-installers.test.ts`.
- Create: `test/composition/create-api-v1-route-installers.test.ts`.
- Delete after transfer: `create-rallar-admin-route-initializers.ts`.

**Interfaces:**

```ts
export interface ApiV1RouteInstallers {
  readonly ws: RallarServerRouteInstaller<Hono>;
  readonly rest: readonly RallarServerRouteInstaller<Hono>[];
}

export function createApiV1SystemInstallers(
  input: CreateApiV1SystemInstallersInput,
): RallarServerSystemInstallers<ApiV1Runtime>;

export function createApiV1RouteInstallers(
  input: CreateApiV1RouteInstallersInput,
): ApiV1RouteInstallers;
```

- [x] **Step 1: Write system installer RED tests**

Prove default-topic reinstall stops and unregisters the prior topic owner; CRDT topics require the
constructed AppInbox mutation ingress; WebSocket lifecycle registers exactly one stop; enqueue
translations, retry delays, release facts, and failure timing match the current server suite.

- [x] **Step 2: Write route installer RED tests**

Use a Hono app plus complete fake dependencies. Mount the returned WS and REST installers and prove
the existing representative config, ICE, client, group, graph, statistics, admin, CRDT, Swagger, and
WebSocket routes are registered. Assert behavior through requests, not source text or a path
inventory.

- [x] **Step 3: Run RED, implement installers, and run GREEN**

Move system and route wiring from the retiring server file. Keep all service construction outside
route installer creation. Absorb admin route inventory directly; delete the one-use admin
initializer factory. Preserve installer order because route shadowing and middleware order are
observable.

Run new tests, `test/rallar-server.test.ts`, focused route suites, and `deno task check`.

- [x] **Step 4: Review, commit, push, and update PR #257**

Commit:

```bash
git commit -m "refactor(api-v1): make server installers explicit"
git push
```

### Task 7: Create the required and default server factories, then migrate consumers

**Files:**

- Create: `composition/create-rallar-server.ts`.
- Create: `composition/create-default-rallar-server.ts`.
- Modify/split: `test/rallar-server.test.ts` into behavior-named composition suites.
- Modify: `apps/api-v1/src/main.ts`.
- Modify: `apps/relic-hunter-server-v1/src/main.ts`.
- Delete: root `apps/api-v1/src/create-rallar-server.ts` after migration.
- Update all active imports/docs/tests that name the root factory.

**Interfaces:**

```ts
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

export interface CreateDefaultRallarServerOptions {
  readonly ws?: RallarServerWsFacadeOptions;
}

export function createDefaultRallarServer(
  options?: CreateDefaultRallarServerOptions,
): RallarServerApplication<ApiV1Runtime, Hono>;
```

- [x] **Step 1: Write required-factory RED tests**

Build a complete fake `ApiV1Runtime` and explicit installers. Assert `createRallarServer` preserves
their identities, mounts each installer once, exposes the same Rallar Game extension surface, and
starts the same QueueBox engine. The test must compile only with complete required input.

- [x] **Step 2: Write default-factory RED tests**

Exercise the production default path with PGlite and controlled configuration. Assert the one
translated database identity reaches runtime, topology, admin, CRDT, and app-data repositories;
default WS behavior is unchanged; and Relic WS options override only the two approved fields.

- [x] **Step 3: Run RED and implement both factories**

`createRallarServer` contains one call to `createRallarServerApplication` and no defaults, config
reads, SQL conversion, service construction, or forward capture.

`createDefaultRallarServer` reads all operational inputs, calls `toPSqlSql(getSql())` once,
constructs lifecycle/runtime/topology/admin/system/routes/default repositories in visible phases,
then calls `createRallarServer`.

- [x] **Step 4: Migrate API-v1 and Relic entry points**

API-v1:

```ts
const rallar = createDefaultRallarServer();
```

Use `rallar.runtime.authSessionRepository` for the API auth middleware and
`rallar.runtime.backgroundTasks.stop` for unload and health shutdown.

Relic:

```ts
const rallar = createDefaultRallarServer({
  ws: {
    allowImplicitUserTopics: false,
    defaultFanout: 'live-only',
  },
});
```

Use `rallar.runtime.authSessionRepository` for REST auth and
`rallar.runtime.groupStateService.readSnapshot` for policy reads. Remove the independent app-local
group-state constructor import.

- [x] **Step 5: Prove no compatibility path remains**

Run:

```bash
rg -n "CreateRallarServerOptions|createRallarServer\(\)|getMiddleware|initialiseMiddleware|shutdownMiddlewareBackgroundTasks|registerMiddlewareBackgroundTask|getClientStateService|getGroupStateService|getWsStateSyncPublisher|as unknown as PSqlSql" apps/api-v1 apps/relic-hunter-server-v1
```

Expected: no production match. Test names may mention rejected predecessor behavior only when the
test is semantic and temporary wording is removed before commit.

- [x] **Step 6: Run GREEN consumer validation**

Run:

```bash
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno task lint
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  test/composition test/rallar-server.test.ts
cd apps/relic-hunter-server-v1 && deno task check
cd apps/relic-hunter-server-v1 && deno task test
```

Execution finding: the Relic server type-checks through the new default factory, but its declared
`deno task test` command has no test modules and exits 1. This pre-existing validation gap is tracked
by [issue #261](https://github.com/intact-software-systems/ar-eye-hunter/issues/261); this slice does
not hide the failed command or expand into a new Relic test program.

- [x] **Step 7: Review, commit, push, and update PR #257**

Commit:

```bash
git commit -m "refactor(api-v1): separate default and required server assembly"
git push
```

### Task 8: Restore navigation, close standards and legacy, and validate delivery

**Files:**

- Create: `apps/api-v1/src/composition/README.md`.
- Modify: `apps/api-v1/README.md`.
- Modify: `docs/environment-variables.md`.
- Modify: `packages/shared-server/rallar-server-repositories.md`.
- Modify only accurate repo-governance fixtures that identify current owners.
- No historical plan, receipt, catalog, digest, or completion ledger changes.

- [x] **Step 1: Write current navigation**

Document two code-derived timelines:

1. Construction/registration: raw database and config -> SQL translation -> lifecycle -> runtime ->
   topology/admin -> system/routes -> required application -> topic/lifecycle/route registration.
2. Runtime invocation/shutdown: REST/WS entry -> auth -> AppInbox or read owner -> response/outbox;
   readiness -> queue workers; unload/health failure -> runtime-owned background stop.

Link every current owner and entry directly. Remove old `createRallarServer()` and
`initialiseMiddleware` guidance.

Execution evidence: `apps/api-v1/src/composition/README.md` now maps both timelines and the active
API, environment, repository, auth, group-state, and topology navigation points link to the current
composition owners. Current guidance no longer names the deleted root factory or middleware
initializer.

- [x] **Step 2: Perform cold code-only navigation review**

Starting separately at API-v1 `main.ts` and Relic `main.ts`, follow production symbols without the
design, plan, Git history, or file inventory. Record in the PR whether a reviewer can locate
defaults, SQL translation, runtime creation, route/system registration, AppInbox ingress, failures,
readiness, and shutdown without a wrong-file guess or hidden lookup. One coherent consolidation is
required before escalating a failed navigation probe.

Execution evidence: separate traces from API-v1 and Relic `main.ts` located defaults, the single SQL
translation, runtime creation, topology/admin composition, system and route installation, AppInbox
ingress, failure propagation, readiness, and shutdown without a wrong-file guess or hidden lookup.

- [x] **Step 3: Complete touched-file and construction review**

Run:

```bash
npm run check:repo-style
npm run check:repo-style:construction-details -- --root apps/api-v1/src
npm run check:repo-style:changed -- 04615706883bef612cdf40f13e488a98644b8710
npm run check:repo-structure -- --base 04615706883bef612cdf40f13e488a98644b8710
npm run test:repo-structure
npm run review:legacy -- 04615706883bef612cdf40f13e488a98644b8710 HEAD
```

If the authenticated merge base changed, replace the three exact base arguments consistently. Read
every changed human-authored file in full. Resolve every real finding; classify false positives by
path/rule/symbol in the PR. Trace every changed production path and classify all affected legacy.

Execution evidence: changed-file style passed; construction review found only reviewed boundary,
route, and untouched baseline warnings; structure passed with the existing singleton operations-test
notice; structure tests passed 14/14. Legacy review returned 22 inspected candidates: deleted legacy,
current fallback/protocol vocabulary, and current composition owners only.

- [x] **Step 4: Run focused and broad affected validation**

Run:

```bash
cd apps/api-v1 && deno fmt --check
cd apps/api-v1 && deno task lint
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno task test
cd apps/relic-hunter-server-v1 && deno fmt --check
cd apps/relic-hunter-server-v1 && deno task check
cd apps/relic-hunter-server-v1 && deno task test
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
npm run test:repo-governance
git diff --check
```

The state-write performance gate is not selected unless evidence proves a mutation path or
concurrency domain changed. If activated, run a fresh migrated-database baseline and candidate with
the exact comparative command from the testing skill.

Execution evidence: API-v1 check and 467 tests passed; changed API-v1/Relic files passed Deno format
and lint; Relic check passed. Relic's test task still has no test modules, tracked by issue #261.
Repository governance passed 360/360. The memory matrix passed 22/22, medium PostgreSQL churn passed
1/1 with 2,748 successful operations, and topology replay exited 0 with a complete live-replay and
reconnect-hydration proof. The full API-v1 formatter and linter remain independently red on 18
untouched files and 30 untouched lint findings; neither set intersects this branch's changed files.
The state-write performance gate was not activated because composition ownership changed without a
mutation algorithm or concurrency-domain change.

- [x] **Step 5: Inspect live PR state before broad reruns or base work**

Run:

```bash
npm run pr:delivery -- status
```

Repair `REPAIR_CONFLICT` before final validation. Diagnose `REPAIR_CHECK`. Do not rebase or merge
main merely for `BEHIND` while GitHub reports the PR mergeable.

Execution evidence: `pr:delivery -- status` reported PR #257 in draft `WORK` state with no conflict;
no base merge or rebase was performed.

- [x] **Step 6: Final requirement audit**

Re-read the design and this plan line by line. For every acceptance item, identify current source,
semantic test, command result, and PR evidence. Treat missing or indirect evidence as incomplete.
Confirm issue #237 is addressed by the actual diff and that no required work was replaced by an
issue.

Execution evidence: the final source search finds exactly one production SQL translation call, one
required factory, one default factory, both consumers on the default factory, and no deleted locator,
middleware initializer, options compatibility type, or SQL double assertion. Semantic tests and the
black-box proof cover the selected design. The diff itself addresses issue #237; issues #259 and
#261 record independent weaknesses rather than replacing required work.

- [ ] **Step 7: Commit and publish navigation/closure**

Commit:

```bash
git commit -m "docs(api-v1): map explicit server composition"
git push
```

Update PR #257 with final Goal, Changes, Acceptance, exact Validation results, Risk and rollback,
and Follow-up issue URLs or `None`.

- [ ] **Step 8: Request delivery readiness once**

Run:

```bash
npm run pr:delivery -- ready
```

Report the exact state. Do not perform post-merge governance work if GitHub later reports `DONE`.

## Completion evidence

Completion requires all of the following current-state evidence:

- production search proves one default factory, one required factory, one SQL translation, no
  locator/global/getter path, no double assertion, and no compatibility wrapper;
- semantic composition and route tests prove construction order, dependency identity, installer
  behavior, lifecycle cleanup, failure timing, and consumer behavior;
- API-v1 and Relic Deno checks/tests pass;
- selected black-box memory, medium PostgreSQL, and topology replay gates pass without weakened
  constants or assertions;
- changed-file style, construction, structure, formatting, and manual navigation review support the
  claimed ownership;
- affected legacy review has no unclassified or silently retained item;
- PR #257 contains the current diff, validation, risk, rollback, and follow-up truth; and
- the live delivery command reports the appropriate review/merge state.
