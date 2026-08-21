# API-v1 Group-State Route Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for every behavior or contract-facing
> change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API-v1 group-state HTTP boundary directly navigable from
route registration through parsing, authentication, request translation,
AppInbox completion, response serialization, and every normal or failed exit,
without changing API or authoritative behavior.

**Architecture:** Replace the 1,211-line mixed group-state route module with a
feature-first `apps/api-v1/src/group-state/` folder. One descriptive registrar
installs five cohesive route families. A named request reader preserves request
ID defaults, a single request-to-AppInbox representation boundary preserves all
17 mutation envelopes, and named authorization, response, error, and dependency
owners keep the HTTP call path visible. The first implementation pull request
performs behavior-neutral movement and test mirroring. A second pull request
aligns only the moved code with the repository standard and removes the
temporary one-hop internal route compatibility files after their removal
condition is proven.

**Tech Stack:** TypeScript 7.0.2, Deno, Hono, OpenAPI YAML, AppInbox, Vitest,
API-v1 black-box recipes, the warning-only repository style checker, Git, and
GitHub Actions.

## Global Constraints

- This is the API-v1 child of the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)
  and follows the
  [program execution protocol](repo-human-traceability-program-execution-plan.md).
- The human must approve the exact Git blob of this plan before implementation.
  Approval applies only to this child and its two sequential implementation
  pull requests. Each merge remains a separate human decision.
- Use one child-specific goal after approval and reuse it across both
  implementation pull requests.
- PR A performs characterization, route/test movement, the explicit HTTP
  representation boundaries, and the minimum registration/documentation
  updates needed to make the new owners active.
- PR B begins only after PR A's exact resulting `main` SHA passes **Run Hetzner
  Supported Distributed Manifests**. It performs behavior-neutral
  code-standard alignment and removes only the two approved temporary internal
  compatibility files after their removal condition passes.
- Preserve every HTTP path and method, OpenAPI path/schema/security contract,
  status code, JSON field and property order, omission/default rule,
  authentication and authorization decision, request-ID precedence,
  idempotency key, random-ID invocation point, and public return.
- Preserve AppInbox enqueue type, `resourceId`, `contextId`, `senderId`, payload
  field and property order, transaction and retry ownership, total attempts,
  optimistic concurrency, idempotency, receipt, event, audience, required
  outbox intents, final outbox writes, atomicity, observation, wake, and caller
  completion semantics.
- Preserve the authoritative server owners published through PR #59, PR #61,
  PR #62, PR #64, PR #65, and ledger PR #66. This child may import them but may
  not reorganize or modify them.
- Preserve TypeScript `7.0.2`, dependencies, lockfiles, workflows, all
  performance thresholds, checker implementation, and warning-only checker
  behavior.
- Keep every new or materially changed human-authored module at or below 400
  physical lines and every new or materially changed general function at or
  below 60 physical lines. Do not satisfy those limits with pass-through
  helpers, generic dependency bags, extra compatibility hops, hidden defaults,
  or duplicated state.
- Preserve
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  unchanged at SHA-256
  `0eea5bdfae06aa25005790220b9331ad721eaf5c917b50c8693cef4d5b185189`.
- Do not begin a Wave 2 authoritative-domain child or the broader Wave 3
  API-v1 composition/configuration refactor in this child.
- Keep future implementation, pull-request, merge, workflow, and later-ledger
  facts outside the Git trees that would create them.

---

Date: 2026-08-03

Status: Approved. Planning PR #67, structure PR #68, code-standard alignment
PR #69, and later evidence-ledger PR #70 are complete; this child is
`ledger-published`. A separately reviewed human decision satisfied this exact
temporary structure ratchet's existing removal condition. Persistent semantic
coverage remains the route, lineage, and active-path owners.

## 1. Prerequisite Evidence And Approval Boundary

The authoritative server work is `ledger-published` before this plan begins:

- ledger PR #66;
- ledger feature head `6e2ea5e4c727f431743e0ad6eab55a0fc9d9af1b`;
- frozen ledger tree `111995e3a72eb246fd0b8028aada4fbeda65fe69`;
- Branch Release Gate run `30778763061`, attempt 1, success for that feature;
- resulting `main` SHA `04b041824073e50a4f1623ca9a71d0d02b770c12`;
- resulting `main` tree `111995e3a72eb246fd0b8028aada4fbeda65fe69`;
  and
- **Run Hetzner Supported Distributed Manifests** run `30780849548`, attempt 1,
  success for that exact resulting-main SHA.

This planning branch starts from that exact SHA and tree. These facts authorize
drafting only. They do not approve this plan, either implementation PR, a
semantic API change, the later ledger, or a subsequent program child.

The completed predecessor plans remain authoritative for their boundaries:

- [governance and warning-only checker](repo-human-traceability-governance-and-checker-plan.md);
- [browser room/group-state translation](rallar-room-group-state-translation-boundary-plan.md);
- [authoritative group-state server structure](rallar-group-state-server-structure-plan.md);
- [server traceability QA](rallar-group-state-server-traceability-qa-plan.md);
  and
- [server traceability hardening](rallar-group-state-server-traceability-hardening-plan.md).

## 2. Current Evidence And Review Pressure

### 2.1 Current route responsibilities

`apps/api-v1/src/routes/group-state-routes.ts` is 1,211 physical lines and owns
all of these concerns at once:

1. four HTTP read registrations;
2. seventeen authenticated mutation registrations;
3. service, authentication, AppInbox, and cache-hydration defaults;
4. JSON parsing and request-ID fallback;
5. actor, creator, principal, and session projection;
6. group request and presence request validation;
7. strict-read and update authorization;
8. AppInbox envelope construction and completion waiting;
9. durable-result, join-code, and presence-receipt adaptation;
10. post-read cache hydration; and
11. scope/context-ID construction.

`apps/api-v1/src/routes/group-state-route-errors.ts` separately owns AppInbox
failure reconstruction and HTTP error serialization. The route file re-exports
one error function, which makes the canonical error owner less obvious.

### 2.2 Current test responsibilities

`apps/api-v1/test/routes/state-api-routes-hardening.test.ts` is 1,822 physical
lines. It mixes client-state and group-state route behavior, three intentional
cross-feature parity cases, route fixtures, snapshots, events, authorization,
errors, validation, and AppInbox envelope literals. This obscures which test is
the first place to look for a group route family and prevents the production
folder from having a mirrored test owner.

The existing tests provide important predecessor evidence and must not be
weakened:

- invalid client and group requests stop before AppInbox;
- strict and non-strict reads retain their exact policy behavior;
- point reads use the durable current snapshot;
- reads hydrate process caches without turning hydration failure into a failed
  committed mutation;
- event array and page routes retain bounded/paged ownership;
- canonical and legacy AppInbox failures retain status, code, message, and
  details;
- join, invite, join-code, membership, governance, and presence routes retain
  independently written enqueue literals; and
- all existing response, call-count, policy, and identity assertions remain.

### 2.3 Existing public and repository consumers

The HTTP contract is consumed by:

- `packages/shared-web/browser/api-integration.ts` and the browser workflows
  above it;
- the Rallar black-box workbench, recipes, manifests, and examples;
- `apps/api-v1/resources/api-v1-openapi.yaml` and Swagger consumers;
- API-v1 route, server, PGlite/PostgreSQL, and black-box tests; and
- external HTTP callers that know only the published paths and JSON contracts.

The current internal route-module path is consumed by:

- `apps/api-v1/src/create-rallar-server.ts`;
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`;
- `packages/shared-server/rallar-system/group-state/README.md`;
- `packages/tests/repo/group-state-navigation-map-integrity.test.ts`; and
- the mutation-routing marker, inventory, and owner-analysis tests under
  `packages/tests/shared-server/`.

The current API-v1 group-state service compatibility module is consumed by the
group-state, graph-topology, and SPA-statistics routes and their tests. It is
not moved by this child.

## 3. Exact Current And Target Trees

### 3.1 Current production and contract tree

The exact production and contract files in scope or explicitly retained are:

```text
apps/api-v1/
  resources/
    api-v1-openapi.yaml                         # retained byte-for-byte
  src/
    main.ts                                     # retained byte-for-byte
    create-rallar-server.ts                     # registration import/call only
    middleware.ts                               # retained byte-for-byte
    middleware-contract.ts                      # retained byte-for-byte
    routes/
      group-state-routes.ts                     # 1,211-line current owner
      group-state-route-errors.ts               # current error owner
    services/
      group-state-service.ts                    # retained API-v1 compatibility owner
      request-auth-service.ts                   # retained authentication owner
      state-api-resilience-middleware.ts        # retained HTTP failure shell
packages/shared/api/
  group-types.ts                                # retained HTTP DTO source
  state-types.ts                                # retained request DTO source
packages/shared-web/browser/
  api-integration.ts                            # retained HTTP consumer
```

The retained files are part of the compatibility proof, not authorized edit
targets unless a task below names the exact permitted change.

### 3.2 PR A production target tree

PR A creates this exact feature-first tree and keeps two one-hop compatibility
files for one publication interval:

```text
apps/api-v1/src/
  create-rallar-server.ts
  group-state/
    create-group-state-route-dependencies.ts
    group-state-route-authorization.ts
    group-state-route-contracts.ts
    group-state-route-errors.ts
    read-group-state-route-request.ts
    register-group-admission-routes.ts
    register-group-membership-routes.ts
    register-group-presence-routes.ts
    register-group-state-mutation-routes.ts
    register-group-state-read-routes.ts
    register-group-state-routes.ts
    to-group-state-command.ts
    to-group-state-response.ts
  routes/
    group-state-routes.ts                       # direct one-hop PR A compatibility export
    group-state-route-errors.ts                 # direct one-hop PR A compatibility export
  services/
    group-state-service.ts                      # retained unchanged
```

Each filename has one matching primary symbol or one intentionally shared
contract surface:

| File                                       | Primary owner                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `create-group-state-route-dependencies.ts` | `createGroupStateRouteDependencies`                                        |
| `group-state-route-authorization.ts`       | `createGroupStateRouteAuthorization`                                       |
| `group-state-route-contracts.ts`           | Shared internal route/dependency/command input contracts only              |
| `group-state-route-errors.ts`              | `toGroupStateErrorResponse` and directly related AppInbox failure decoding |
| `read-group-state-route-request.ts`        | `readGroupStateRouteRequest`                                               |
| `register-group-admission-routes.ts`       | `registerGroupAdmissionRoutes`                                             |
| `register-group-membership-routes.ts`      | `registerGroupMembershipRoutes`                                            |
| `register-group-presence-routes.ts`        | `registerGroupPresenceRoutes`                                              |
| `register-group-state-mutation-routes.ts`  | `registerGroupStateMutationRoutes`                                         |
| `register-group-state-read-routes.ts`      | `registerGroupStateReadRoutes`                                             |
| `register-group-state-routes.ts`           | `registerGroupStateRoutes`                                                 |
| `to-group-state-command.ts`                | `toGroupStateCommand`                                                      |
| `to-group-state-response.ts`               | `toGroupStateResponse`                                                     |

`registerGroupStateRoutes` only creates the resolved dependency and
authorization owners and invokes the five registrars in the predecessor route
order. It does not implement a route or domain decision.

### 3.3 Final PR B production tree

PR B removes the two old `routes/group-state-*.ts` compatibility files only
after Section 7.2's removal condition is satisfied. The final canonical tree is
therefore the `group-state/` tree above plus the existing registration call in
`create-rallar-server.ts`; no route implementation remains under
`src/routes/`.

The broader target composition folder in the master program is deliberately
not created here. `middleware.ts`, `main.ts`, middleware construction,
environment configuration, and non-group route registration belong to the
later Wave 3 composition/configuration child.

### 3.4 Current test and evidence tree

```text
apps/api-v1/test/
  rallar-server.test.ts
  swagger-routes.test.ts
  routes/
    state-api-routes-hardening.test.ts
  services/
    group-state-service.test.ts
packages/tests/
  repo/
    group-state-navigation-map-integrity.test.ts
  shared-server/
    app-inbox-mutation-routing-contract.test.ts
    mutation-route-owner-*.test.ts
    mutation-routing-*.ts
  shared-web/
    rallar-group-docs-compat.test.ts
packages/shared-test/black-box-runner/tests/api-v1/
  api-v1-group-presence.json
  api-v1-scope-isolation.json
  api-v1-state-write-convergence.json
```

The authoritative shared-server group-state tests and API-v1
`test/services/group-state-service.test.ts` are validation evidence, not move
targets. Historical plans and historical reports are not rewritten.

### 3.5 Final mirrored test tree

```text
apps/api-v1/test/
  rallar-server.test.ts                         # retained
  swagger-routes.test.ts                        # retained
  client-state/
    client-state-mutation-routes.test.ts
    client-state-read-routes.test.ts
    client-state-route-test-runtime.ts
  group-state/
    group-admission-routes.test.ts
    group-membership-routes.test.ts
    group-presence-routes.test.ts
    group-state-mutation-routes.test.ts
    group-state-openapi-contract.test.ts
    group-state-read-routes.test.ts
    group-state-route-errors.test.ts
    group-state-route-test-runtime.ts
    register-group-state-routes.test.ts
  routes/
    state-api-cross-feature-routes.test.ts
  services/
    group-state-service.test.ts                 # retained
packages/tests/
  repo/
    api-v1-group-state-route-structure.test.ts
    group-state-navigation-map-integrity.test.ts
  shared-server/
    app-inbox-mutation-routing-contract.test.ts
    mutation-route-owner-*.test.ts
    mutation-routing-*.ts
  shared-web/
    rallar-group-docs-compat.test.ts
```

The client-state test files are authorized only as a test-only extraction from
the mixed predecessor module. No client-state production file, behavior,
fixture value, literal, or assertion may change. The three cross-feature cases
remain intact in `state-api-cross-feature-routes.test.ts`: cache hydration,
event page ownership, and bounded event-array ownership. They are not split
into weaker single-feature substitutes.

The 25 predecessor cases move by this exact ownership map:

| Target test owner                        | Existing cases moved intact                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client-state-read-routes.test.ts`       | Non-strict non-self read; strict non-self snapshot/event rejection.                                                                                                                                           |
| `client-state-mutation-routes.test.ts`   | Malformed mutation pre-enqueue rejection; equal causal lifecycle boundary; terminal idempotency 409; base-era AppInbox status/message; remote-result cache hydration; committed success when hydration fails. |
| `state-api-cross-feature-routes.test.ts` | Client/group successful-read cache hydration; paged-service event ownership; bounded recent-event array ownership.                                                                                            |
| `group-state-read-routes.test.ts`        | Strict active-member/non-member reads; durable current point read; banned snapshot/event rejection; full-state visibility policy.                                                                             |
| `group-state-route-errors.test.ts`       | Canonical AppInbox status/code/message; stable read policy response; stable lifecycle policy response; legacy AppInbox policy details.                                                                        |
| `group-state-mutation-routes.test.ts`    | All non-presence malformed bodies stop pre-enqueue; aggregate create/update/director characterization added before movement.                                                                                  |
| `group-admission-routes.test.ts`         | Join intent; invite create/revoke/accept; join-code rotation; exact missing admission-family command variants added before movement.                                                                          |
| `group-membership-routes.test.ts`        | Governance remove/ban/unban/role/ownership workflows; exact self-upsert variant added before movement.                                                                                                        |
| `group-presence-routes.test.ts`          | Presence generation validation plus exact connect/heartbeat/disconnect command and response variants.                                                                                                         |

`register-group-state-routes.test.ts` owns only registration order/count and
resolved-dependency construction. `group-state-openapi-contract.test.ts` owns
the published path/method/security/request/response inventory. The shared test
runtime owns only reusable Hono installation, dependency fakes, auth sessions,
and domain fixtures; expected AppInbox and raw JSON literals stay in their
behavior test files.

## 4. Complete Current-To-Target Move Map

| Current owner or responsibility                                     | Target owner                                                | Rule                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `group-state-routes.ts` `init`                                      | `register-group-state-routes.ts` `registerGroupStateRoutes` | Preserve registration order and route count; registrar owns no handler behavior.             |
| Four group snapshot/event GET handlers                              | `register-group-state-read-routes.ts`                       | Preserve strict-read policy, durable/current read choices, pagination, and hydration.        |
| Create, update, and director-appoint handlers                       | `register-group-state-mutation-routes.ts`                   | Preserve pre-update authorization order and create status 201.                               |
| Join, invite create/revoke/accept, and join-code rotate handlers    | `register-group-admission-routes.ts`                        | Preserve exact request fields, actor overrides, and join-code response projection.           |
| Remove, ban, unban, role, ownership transfer, and self-upsert       | `register-group-membership-routes.ts`                       | Preserve self-service checks, ignored role projection, and exact policy/error order.         |
| Presence connect, heartbeat, and disconnect handlers                | `register-group-presence-routes.ts`                         | Preserve self-session check, validation, receipt handling, and post-receipt current read.    |
| Optional route dependencies and default resolution                  | `create-group-state-route-dependencies.ts`                  | Preserve every default and resolve them once at registration.                                |
| Route types and discriminated translation inputs                    | `group-state-route-contracts.ts`                            | Internal only; no package entrypoint or public contract.                                     |
| Strict read and update/self authorization helpers                   | `group-state-route-authorization.ts`                        | Preserve environment lookup timing, service method selection, policy, and exact errors.      |
| JSON parse plus body/header/random request-ID precedence            | `read-group-state-route-request.ts`                         | Preserve `{ ...body, requestId }` insertion/override behavior and one volatile call.         |
| Validation, actor projection, context ID, and 17 AppInbox envelopes | `to-group-state-command.ts`                                 | One discriminated representation boundary; exact switch, fields, order, and errors.          |
| Written-result, join-code, and presence-receipt adaptation          | `to-group-state-response.ts`                                | Preserve durable/private projection, property order, errors, and snapshot identity.          |
| AppInbox failure and HTTP error mapping                             | `group-state-route-errors.ts`                               | Move bodies unchanged first; preserve status/code/message/details and fallback ordering.     |
| `defaultProcessGroupAppInbox`                                       | `create-group-state-route-dependencies.ts` private default  | Preserve direct completion call and `Either.fold` behavior; add no service/facade hop.       |
| `create-rallar-server.ts` import and `groupStateRoutes.init` call   | Canonical import and `registerGroupStateRoutes` call        | Change only the group-state registration symbol/path and preserve supplied service getter.   |
| Old `routes/group-state-routes.ts`                                  | PR A direct one-hop re-export; deleted in PR B              | No executable logic; exact removal condition in Section 7.2.                                 |
| Old `routes/group-state-route-errors.ts`                            | PR A direct one-hop re-export; deleted in PR B              | No executable logic; exact removal condition in Section 7.2.                                 |
| Mixed client tests and fixtures                                     | `test/client-state/*`                                       | Test-only move; all client cases, fixtures, literals, and assertion sites preserved.         |
| Mixed group tests and fixtures                                      | `test/group-state/*`                                        | Move by route family; preserve every old case and add all-17 translation characterization.   |
| Three client/group parity tests                                     | `state-api-cross-feature-routes.test.ts`                    | Move intact, not split or duplicated.                                                        |
| Group-state OpenAPI assertions in general Swagger evidence          | Retained plus `group-state-openapi-contract.test.ts` focus  | OpenAPI YAML stays unchanged; focused test makes paths/methods/security/schema discoverable. |
| Navigation README/test API-v1 links                                 | Canonical `src/group-state/*` paths and symbols             | Update source-derived navigation only; server runtime owners remain unchanged.               |
| Mutation route inventory and markers                                | Exact five canonical registration/translation source owners | Preserve all 17 HTTP entries and their server owner/dispatch paths.                          |
| `package.json` hardening command                                    | Exact new client/group/cross-feature test paths             | Registration-only update; no script behavior or unrelated command change.                    |

The move begins from bodies proven by predecessor tests. A function may be
renamed only to the exact target symbol above. Semantic cleanup, changed
validation, new defaults, new OpenAPI metadata, or generalized route helpers
are not part of movement.

## 5. Construction, Registration, And Runtime Timelines

### 5.1 Current construction and registration

```text
apps/api-v1/src/main.ts module initialization
  -> new Hono()
  -> install CORS, HTTP timing, state auth, and resilience middleware
  -> createRallarServer()
     -> initialiseMiddleware()
        -> createRallarMiddleware(...)
        -> create cached GroupStateService
        -> construct AppGroupInboxService and register its queue handlers
     -> construct repository/topology/admin/runtime collaborators
     -> createRallarServerApplication({ routes.rest })
        -> capture wrapper that will call groupStateRoutes.init(...)
  -> rallar.rest.mount(app)
     -> invoke REST installers in array order
     -> groupStateRoutes.init(app, { getGroupStateService })
     -> resolve route defaults and register 21 handlers
  -> await runtime readiness
  -> rallar.start()
  -> Deno.serve(...)
```

Registration is construction-time work. It is not a request-time AppInbox
step. The route callback is invoked only later by Hono.

### 5.2 Target construction and registration

```text
createRallarServer()
  -> createRallarServerApplication({ routes.rest })
     -> capture wrapper that calls registerGroupStateRoutes(...)
rallar.rest.mount(app)
  -> registerGroupStateRoutes(app, provided dependencies)
     -> createGroupStateRouteDependencies(provided dependencies)
     -> createGroupStateRouteAuthorization(resolved dependencies)
     -> registerGroupStateReadRoutes(...)
     -> registerGroupStateMutationRoutes(...)
     -> registerGroupAdmissionRoutes(...)
     -> registerGroupMembershipRoutes(...)
     -> registerGroupPresenceRoutes(...)
```

The five registrars receive resolved, valid dependencies. They do not read
global middleware, environment, or service defaults. Defaults are resolved
once by the named construction owner. `registerGroupStateRoutes` preserves the
exact predecessor registration order: four reads followed by the seventeen
mutations in their current order.

### 5.3 Representative HTTP-to-authoritative-write trace

The `POST .../groups` create path is the representative top-to-bottom trace:

```text
HTTP request
  -> Hono CORS middleware
  -> createHttpTimingMiddleware
  -> global /api/state/* requireApiAuthSession
     early exit: exact auth error response
  -> createStateApiResilienceMiddleware
  -> handler registered by registerGroupStateMutationRoutes
     -> dependencies.requireApiAuthSession(request)
        early exit: route error catch -> toGroupStateErrorResponse
     -> read scope path parameters
     -> readGroupStateRouteRequest<CreateGroupRequest>
        -> await request.json()
        -> requestId = body.requestId
             ?? Idempotency-Key header
             ?? crypto.randomUUID()
        early exit: parse failure -> route error response
     -> toGroupStateCommand({ operation: 'create-group', ... })
        -> with actor and creator using the authenticated session
        -> validateGroupMutationRequest('createGroup', request)
        -> construct exact GROUP_CREATE AppInbox enqueue
        early exit: validation failure -> route error response
     -> processGroupAppInbox(authSession, enqueue)
        -> default owner calls getMiddleware().appGroupInboxService
           .processAuthenticatedEntryUntilCompletion(enqueue, authority)
        -> AppInbox reserves and later dispatches the durable command
        -> GroupStateInboxHandler.processGroupStateMutation
        -> authoritative read -> compute -> validate
        -> AppInboxTransactionWriter owns transaction/retry
        -> write accepted state, receipt, event, and required outbox intents
        -> commit, finalize result, observe committed snapshot, wake queue
        -> return durable completion through Either
        terminal failure: fold maps failure with toGroupAppInboxError and throws
     -> toGroupStateResponse({ kind: 'mutation', written })
        -> require the right mutation result
        -> retain exact snapshot identity
     -> context.json(snapshot, 201)
        normal HTTP exit
  -> timing/resilience middleware completes or translates only as before
```

The route boundary does not own a transaction, retry, receipt, outbox, or
persistence decision. It owns HTTP parsing/authentication, representation
translation, AppInbox submission/waiting, and HTTP serialization.

### 5.4 Representative HTTP query trace

The `GET .../groups/:groupId` point read remains:

```text
HTTP request
  -> global state authentication middleware
  -> handler registered by registerGroupStateReadRoutes
  -> read groupId and scope
  -> GroupStateRouteService.readCurrentSnapshot(ref)
     early exit: exact 404 body when absent
  -> authorization.requireSnapshotRead(request, snapshot)
     -> when strict-read flag is disabled: no route-level session/policy read
     -> when enabled: require session and apply canReadGroupSnapshot
     early exit: exact policy/auth response
  -> schedule hydrateStateSyncSnapshotCaches({ groups: [snapshot] })
     failure exit: one warning; committed/read success is preserved
  -> context.json(snapshot)
```

List reads, event array reads, and event page reads retain their existing
service method choices. The event-array fallback may call `listEvents` only
when `listRecentEvents` is absent. This child may not change the fallback or
pagination semantics.

## 6. Exact Ownership Decisions

### 6.1 Locked internal boundary contracts

No contract in this section becomes a package export or changes a public
method. The canonical server type remains the return boundary:

```ts
function toGroupStateCommand(input: GroupStateRouteCommandInput): AuthenticatedGroupMutationEnqueue;
```

`GroupStateRouteCommandInput` is a readonly discriminated union. It contains
the already-parsed request, authenticated route session, scope, and only the
path fields required by its operation. It has exactly these mappings:

| `operation`                 | Request type                            | Existing validator operation | AppInbox type               | Exact payload type                       |
| --------------------------- | --------------------------------------- | ---------------------------- | --------------------------- | ---------------------------------------- |
| `create-group`              | `CreateGroupRequest`                    | `createGroup`                | `GROUP_CREATE`              | `GroupCreateAppInboxPayload`             |
| `update-group`              | `UpdateGroupRequest`                    | `updateGroup`                | `GROUP_UPDATE`              | `GroupUpdateAppInboxPayload`             |
| `appoint-group-director`    | `AppointGroupDirectorRequest`           | `appointDirector`            | `GROUP_DIRECTOR_APPOINT`    | `GroupDirectorAppointAppInboxPayload`    |
| `join-group`                | `JoinGroupRequest`                      | `joinGroup`                  | `GROUP_JOIN`                | `GroupJoinAppInboxPayload`               |
| `create-group-invite`       | `CreateGroupInviteRequest`              | `createGroupInvite`          | `GROUP_INVITE_CREATE`       | `GroupInviteCreateAppInboxPayload`       |
| `revoke-group-invite`       | `RevokeGroupInviteRequest`              | `revokeGroupInvite`          | `GROUP_INVITE_REVOKE`       | `GroupInviteRevokeAppInboxPayload`       |
| `accept-group-invite`       | `AcceptGroupInviteRequest`              | `acceptGroupInvite`          | `GROUP_INVITE_ACCEPT`       | `GroupInviteAcceptAppInboxPayload`       |
| `rotate-group-join-code`    | `RotateGroupJoinCodeRequest`            | `rotateGroupJoinCode`        | `GROUP_JOIN_CODE_ROTATE`    | `GroupJoinCodeRotateAppInboxPayload`     |
| `remove-group-member`       | `RemoveGroupMemberRequest`              | `removeGroupMember`          | `GROUP_MEMBER_REMOVE`       | `GroupMemberRemoveAppInboxPayload`       |
| `ban-group-member`          | `BanGroupMemberRequest`                 | `banGroupMember`             | `GROUP_MEMBER_BAN`          | `GroupMemberBanAppInboxPayload`          |
| `unban-group-member`        | `UnbanGroupMemberRequest`               | `unbanGroupMember`           | `GROUP_MEMBER_UNBAN`        | `GroupMemberUnbanAppInboxPayload`        |
| `set-group-member-role`     | `SetGroupMemberRoleRequest`             | `setGroupMemberRole`         | `GROUP_MEMBER_ROLE_SET`     | `GroupMemberRoleSetAppInboxPayload`      |
| `transfer-group-ownership`  | `TransferGroupOwnershipRequest`         | `transferGroupOwnership`     | `GROUP_OWNERSHIP_TRANSFER`  | `GroupOwnershipTransferAppInboxPayload`  |
| `upsert-group-member`       | `UpsertGroupMemberRequest`              | `upsertMember`               | `GROUP_MEMBER_UPSERT`       | `GroupMemberUpsertAppInboxPayload`       |
| `connect-group-presence`    | `ConnectGroupPresenceSessionRequest`    | `connectPresence`            | `GROUP_PRESENCE_CONNECT`    | `GroupPresenceConnectAppInboxPayload`    |
| `heartbeat-group-presence`  | `HeartbeatGroupPresenceSessionRequest`  | `heartbeatPresence`          | `GROUP_PRESENCE_HEARTBEAT`  | `GroupPresenceHeartbeatAppInboxPayload`  |
| `disconnect-group-presence` | `DisconnectGroupPresenceSessionRequest` | `disconnectPresence`         | `GROUP_PRESENCE_DISCONNECT` | `GroupPresenceDisconnectAppInboxPayload` |

The translator imports `AuthenticatedGroupMutationEnqueue` and the exact
payload/request types from their existing owners. It does not add payload
validation or change downstream server validation. Compile-time negative tests
prove that a request/payload for one discriminant cannot be assigned to
another.

The response boundary is exactly:

```ts
type GroupStateResponseInput =
    | Readonly<{ kind: 'mutation'; written: GroupStateWritten; }>
    | Readonly<{ kind: 'join-code'; written: GroupJoinCodeWritten; }>
    | Readonly<{
        kind: 'presence';
        receipt: GroupMutationReceipt;
        ref: GroupRef;
        service: GroupStateRouteService;
    }>;

function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'mutation'; }>
): GroupMutationWritten;
function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'join-code'; }>
): GroupJoinCodeResponse;
function toGroupStateResponse(
    input: Extract<GroupStateResponseInput, { kind: 'presence'; }>
): Promise<GroupSnapshot>;
```

`GroupJoinCodeResponse` is a private alias for the inferred predecessor
join-code projection without `event`; it is not a shared/public DTO. The
implementation switch is exhaustive. It contains no `context.json`, status
selection, authentication, or AppInbox submission.

The dependency construction contract preserves the current optional injection
surface for direct tests and internal consumers:

```ts
interface GroupStateRouteDependencies {
    readonly getGroupStateService?: () => GroupStateRouteService;
    readonly requireApiAuthSession?: GroupStateRouteRequireAuthSession;
    readonly processGroupAppInbox?: ProcessGroupAppInbox;
    readonly hydrateStateSyncSnapshotCaches?: GroupStateRouteCacheHydration;
}

function createGroupStateRouteDependencies(
    input: GroupStateRouteDependencies
): Required<GroupStateRouteDependencies>;

function registerGroupStateRoutes(app: Hono, dependencies?: GroupStateRouteDependencies): void;

interface GroupStateRouteAuthorization {
    readStrictAuthSession(
        request: GroupStateRouteRequest
    ): Promise<GroupStateRouteAuthSession | undefined>;
    assertCanReadGroupRef(request: GroupStateRouteRequest, ref: GroupRef): Promise<void>;
    assertCanReadGroupState(
        request: GroupStateRouteRequest,
        snapshot: GroupSnapshot
    ): Promise<void>;
    assertCanUpdateGroup(principalId: string, ref: GroupRef): Promise<void>;
    assertSelfPrincipal(clientId: string, principalId: string): void;
    assertSelfSession(session: GroupStateRouteAuthSession, sessionId: string): void;
    assertSelfServiceMemberStatus(status: UpsertGroupMemberRequest['status']): void;
}
```

The authorization owner receives the resolved dependencies at registration and
exposes only the current cohesive read/update/self-policy operations. It owns no
route registration, request parsing, command translation, or response mapping.

### 6.2 Responsibility matrix

| Concern                            | Exact owner                                                | Locked decision                                                                                           |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Route registration                 | `register-group-state-routes.ts`                           | Five ordered registrars; no route logic.                                                                  |
| Reads/events                       | `register-group-state-read-routes.ts`                      | HTTP orchestration only; authoritative query service remains server-owned.                                |
| Aggregate mutations                | `register-group-state-mutation-routes.ts`                  | Create/update/director routes only.                                                                       |
| Admission                          | `register-group-admission-routes.ts`                       | Join, invite, accept/revoke, and join-code routes.                                                        |
| Membership governance              | `register-group-membership-routes.ts`                      | Remove/ban/unban/role/owner/self-upsert routes.                                                           |
| Presence HTTP lifecycle            | `register-group-presence-routes.ts`                        | Connect/heartbeat/disconnect HTTP orchestration; server presence semantics unchanged.                     |
| Request parsing/default            | `read-group-state-route-request.ts`                        | JSON plus exact body/header/random request-ID precedence only.                                            |
| Validation and command translation | `to-group-state-command.ts`                                | Existing validators, actor overrides, context ID, and exact 17 AppInbox envelopes.                        |
| Authentication                     | Existing `request-auth-service.ts`                         | No auth implementation move or change.                                                                    |
| Route authorization                | `group-state-route-authorization.ts`                       | Strict-read, update, self-principal/session/status checks, and policy error preservation.                 |
| AppInbox completion                | `create-group-state-route-dependencies.ts` private default | Direct call to current AppGroupInboxService; no transaction ownership.                                    |
| Response adaptation                | `to-group-state-response.ts`                               | Durable written result, join-code event omission, and presence receipt/current-snapshot adaptation.       |
| HTTP error serialization           | `group-state-route-errors.ts`                              | Exact policy/canonical/legacy/fallback mapping.                                                           |
| OpenAPI                            | `apps/api-v1/resources/api-v1-openapi.yaml`                | Retained byte-for-byte in this child. Any schema or operation metadata change requires separate approval. |
| Composition                        | Existing `create-rallar-server.ts`                         | Only the group-state registrar import/call changes; broad composition remains Wave 3.                     |
| Public browser consumer            | Existing `packages/shared-web/browser/api-integration.ts`  | Retained byte-for-byte and tested as a caller.                                                            |
| Black-box compatibility            | Existing API-v1 recipe matrix and named recipes            | Retained byte-for-byte; run as end-to-end evidence.                                                       |
| Authoritative mutation             | Published shared-server group-state/AppInbox owners        | No server production change.                                                                              |

`toGroupStateCommand` receives a discriminated internal route-command input
covering exactly the 17 current HTTP mutation operations. It is a real
HTTP-to-AppInbox representation boundary, not a domain service. Its switch is
exhaustive, and tests bind each operation to its exact existing payload type
and independently written enqueue literal.

`toGroupStateResponse` receives a discriminated internal input for normal
mutation, join-code, or presence completion. Route handlers still call
`context.json` with the visible status, so the HTTP exit is not hidden inside a
generic responder.

## 7. Compatibility And Temporary Re-Exports

### 7.1 Public and persisted compatibility

No package entrypoint, shared DTO, HTTP route, OpenAPI document, browser API,
persisted record, storage key, AppInbox contract, receipt, event, or outbox
contract changes. `createRallarServer` keeps its public signature and return.

The API-v1 `services/group-state-service.ts` module remains a direct one-hop
compatibility/construction owner for these known consumers:

- group-state route defaults;
- graph-topology routes;
- SPA-statistics routes; and
- API-v1 service/route tests.

It is not temporary in this child. Its possible removal belongs to the later
Wave 3 composition plan after all consumers receive explicit construction.

### 7.2 Approved PR A temporary internal compatibility

PR A may retain exactly two direct one-hop named compatibility files:

1. `apps/api-v1/src/routes/group-state-routes.ts` re-exports
   `registerGroupStateRoutes` as `init`, the current route types, and
   `toGroupAppInboxError` from the canonical feature owners.
2. `apps/api-v1/src/routes/group-state-route-errors.ts` re-exports only the
   current named error functions from the canonical feature owner.

They contain no executable wrapper, default, state, side effect, wildcard
barrel export, or second hop.

Known consumers before the move are the registration composition, the mixed
route test, the server navigation map/test, and mutation-routing evidence.
PR A moves every repository-owned active consumer to the canonical path. The
compatibility files then protect the prior internal module path for one
resulting-main interval only.

PR B removes both files only when all of these are true:

- PR A's exact resulting-main default workflow succeeded;
- `rg` finds no active repository import of either old path;
- the API-v1 Deno check and all moved route tests pass from canonical imports;
- the navigation map and mutation-route inventory name only canonical paths;
- the old paths are not package exports; and
- independent review confirms removal changes no HTTP or runtime behavior.

If any live consumer remains, PR B keeps the required direct re-export, records
the exact consumer and later removal condition, and stops for human review
before claiming the child complete. It may not add another hop.

## 8. Locked Behavior And Serialization Matrix

| Surface                    | Exact preservation requirement                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Route inventory            | Four GET and seventeen mutation handlers, exact method/path/registration order.                                        |
| Authentication             | Global state auth plus the current route-level auth calls remain; no deduplication in this child.                      |
| Strict reads               | `RALLAR_STATE_STRICT_READ_AUTH` lookup, accepted truthy spellings, and policy decisions remain exact.                  |
| Request parsing            | One `req.json()` call, unchecked transport cast followed by the same existing validators.                              |
| Request ID                 | Body value, then `Idempotency-Key`, then one `crypto.randomUUID()` call; `{ ...body, requestId }` order unchanged.     |
| Actor/creator fields       | Authenticated values override request values at the same point and in the same object-spread/property order.           |
| Scope/context              | Path scope and encoded `[applicationId, workspaceId, groupId].join(':')` remain exact.                                 |
| Update authorization       | Durable/cached method choice, missing-group error, role denial text, and check-before-body order remain exact.         |
| Self service               | Principal/session equality, active/left status restriction, ignored role, and exact errors remain exact.               |
| AppInbox entry             | All 17 types and every envelope/payload field, omission, value, and insertion order remain exact.                      |
| Completion                 | Route waits for `processAuthenticatedEntryUntilCompletion`; no fire-and-forget or direct service mutation.             |
| Mutation response          | Create 201; all other current statuses; exact snapshot identity and JSON.                                              |
| Join-code response         | Event omitted at the same boundary; remaining property order and values unchanged.                                     |
| Presence response          | Rejected receipt text, post-receipt current read, missing-snapshot error, and returned snapshot remain exact.          |
| Read hydration             | Same successful reads schedule the same cache input; failure warns and does not change the response.                   |
| Event reads                | Existing recent-list fallback and paged-service ownership remain exact.                                                |
| Errors                     | Policy, canonical/legacy AppInbox, explicit status/code, fallback status order, body shape, and messages remain exact. |
| OpenAPI/browser/black-box  | Files remain byte-identical; tests prove route/runtime compatibility.                                                  |
| Authoritative side effects | Transaction, retry, idempotency, receipts, events, audience, outbox, observation, wake, and persistence unchanged.     |

Raw JSON and object-order fixtures must compare independently written string
literals for every structurally affected response family and every AppInbox
operation family. Reusing production projection helpers to build expected
values is not acceptable evidence.

## 9. Mutation-Path And Concurrency-Domain Classification

This child **does cross a mutation-path boundary structurally** because the
HTTP request-to-AppInbox enqueue construction moves from one route file into a
named translation owner. It does **not cross a concurrency domain**: the same
AppInbox service remains the only mutation entry, and all queue reservation,
transaction, retry, optimistic-concurrency, idempotency, receipt, event,
outbox, observation, wake, and persistence work stays in the already-published
server owners.

Required mutation-path verification therefore includes:

- an exact 17-operation route-to-AppInbox matrix;
- raw enqueue and response property-order literals;
- pre-enqueue validation and authorization failures;
- mutation-route owner/reachability analysis;
- AppInbox routing/transaction/retry/receipt/outbox suites;
- memory black-box route compatibility; and
- PostgreSQL medium-scale convergence.

The existing governed server performance thresholds are unchanged. A new
governed performance comparison is not required for a pure route/file move
when the executor proves that:

- the AppInbox call count and awaited completion point are unchanged;
- no production code at or below AppInbox, transaction, repository, or outbox
  ownership changed;
- no new asynchronous hop, callback, batching, retry, or serialization work was
  added; and
- API-v1 black-box convergence passes.

If implementation changes any of those facts or affects a transaction-facing
or concurrency-domain owner, execution stops for a plan amendment and an exact
performance decision. It may not silently inherit the pure-move exemption.

Final unchanged-tree re-evaluation from PR A resulting `main`
`4d616edc649fe30ebf0fca48db4ab683d9c512e3` to frozen PR B feature
`bcabb62072fa82759e21fc14f6e7efedd7adf00f` and tree
`620bb455688ee4f927dd662da0fce01a3c0c7bd9` found exactly two
production/runtime changes: deletion of
`apps/api-v1/src/routes/group-state-routes.ts` and
`apps/api-v1/src/routes/group-state-route-errors.ts`. Both deleted modules were
executable-logic-free direct compatibility re-exports. No production code at
or below AppInbox changed; no call, awaited completion point, serialization,
asynchronous hop, retry, or concurrency behavior changed. The approved
pure-move performance exemption therefore remained applicable through the
final PR B freeze.

## 10. Implementation Tasks

### Task 0: Publish And Approve This Child Plan

**Files:**

- Create: `plans/api-v1-group-state-route-structure-plan.md`
- Modify: `plans/repo-human-traceability-refactoring-program-plan.md`
- Modify: `plans/repo-human-traceability-program-execution-plan.md`

- [x] Verify the exact PR #66 ledger envelope and start from exact `main`
      `04b041824073e50a4f1623ca9a71d0d02b770c12` and tree
      `111995e3a72eb246fd0b8028aada4fbeda65fe69`.
- [x] Add this exact plan and reciprocal master/execution links without
      rewriting completed governance, browser, or server history.
- [x] Mark this child drafted and unapproved and preserve the non-circular
      evidence contract.
- [x] Run Section 12.1 on one unchanged planning tree.
- [x] Publish one non-default draft planning PR and require Branch Release Gate
      success for its exact final planning commit.
- [x] Stop for human approval or revision of the exact plan Git blob. Do not
      create an implementation goal or branch before approval and planning
      merge/default-workflow evidence.

### Task 1: Characterize Registration, HTTP Contracts, And All Exits

**Files:** current production/tests from Sections 3.1 and 3.4; characterization
tests may be added only to the PR A target test owners in Section 3.5.

- [x] Start PR A from the planning PR's exact resulting-main SHA only after its
      default workflow succeeds; create one child-specific goal.
- [x] Record current construction and registration order, including the exact
      route installer array position and all 21 Hono registrations.
- [x] Capture every existing test name, fixture, raw literal, `assert` site,
      OpenAPI group path/method/security/schema row, and black-box group recipe
      before moving a test.
- [x] Add test-first all-17 AppInbox characterization: exact type/payload pair,
      scope, IDs, request fields, actor overrides, omissions, and raw property
      order.
- [x] Add exact normal, early, failed, and cleanup/after-commit trace evidence
      for aggregate, admission, membership, presence, read, and event families.
- [x] Prove current request-ID precedence and volatile invocation count.
- [x] Obtain an independent characterization review with Critical 0 and
      Important 0 before production movement.

### Task 2: Establish Read, Authorization, Dependency, And Error Owners

**Files:**

- Create: `group-state-route-contracts.ts`
- Create: `create-group-state-route-dependencies.ts`
- Create: `group-state-route-authorization.ts`
- Create: `group-state-route-errors.ts`
- Create: `register-group-state-read-routes.ts`
- Create: `read-group-state-route-request.ts`
- Create/move directly owned tests from Section 3.5
- Modify the two old route files only into the approved direct re-exports

- [x] Move bodies before aligning style; preserve order and error text.
- [x] Resolve defaults once during registration and pass mandatory dependencies
      to route owners.
- [x] Keep environment lookup timing and route-level auth duplication exact.
- [x] Keep current/durable read method selection, policy checks, cache
      hydration, event fallback, and page reads exact.
- [x] Move error behavior without adding an error class or generic responder.
- [x] Run the exact read/error/auth focused suites and independently review the
      cohort with Critical 0 and Important 0.

### Task 3: Establish The Command And Response Boundaries

**Files:**

- Create: `to-group-state-command.ts`
- Create: `to-group-state-response.ts`
- Create/move the exact route-family tests from Section 3.5
- Update only the shared internal contracts required by these owners

- [x] Define one discriminated internal input covering exactly the current 17
      HTTP mutation operations and no server maintenance/WS operation.
- [x] Move validation, authenticated actor/creator projection, context ID, and
      exact AppInbox envelope construction into `toGroupStateCommand`.
- [x] Make the switch exhaustive without changing unsupported-runtime behavior.
- [x] Prove every field, omission, spread override, request identity, random
      invocation, payload type, and raw property order with independent
      literals.
- [x] Move written-result, join-code, and presence-receipt adaptation into
      `toGroupStateResponse`; retain `context.json` and the visible status in
      each route.
- [x] Prove exact error/rejection text, response JSON/order, and snapshot
      identity.
- [x] Independently review the cohort with Critical 0 and Important 0.

### Task 4: Split And Register The Five Route Families

**Files:**

- Create: the five `register-group-*-routes.ts` files and
  `register-group-state-routes.ts`
- Modify: `apps/api-v1/src/create-rallar-server.ts` only for the canonical
  registration import/call
- Split: the mixed predecessor test into the exact final tree in Section 3.5
- Modify: `package.json` only for active test path registration

- [x] Register the five families in exact predecessor order.
- [x] Keep parsing, auth/authorization, translation, submission/read, response,
      and catch/error sequence visible in each route handler.
- [x] Preserve all existing client cases during the required test-only
      extraction; preserve the three cross-feature cases intact.
- [x] Ensure every moved/new test file and general fixture function meets the
      hard size limits without a generic test runtime or dependency bag.
- [x] Run all five route-family suites, the extracted client/cross-feature
      suites, `rallar-server.test.ts`, and the OpenAPI focus.
- [x] Independently review registration, test ownership, and exact diff scope
      with Critical 0 and Important 0.

### Task 5: Reconcile Navigation, Mutation Routing, And Consumers

**Files:**

- Modify: `packages/shared-server/rallar-system/group-state/README.md`
- Modify: `packages/tests/repo/group-state-navigation-map-integrity.test.ts`
- Create: `packages/tests/repo/api-v1-group-state-route-structure.test.ts`
- Modify: exact mutation-routing marker/inventory files whose active paths move
- Modify: directly owned mutation-route tests only when an exact path/symbol
  assertion requires it

- [x] Update the durable navigation map to the new construction/runtime owners
      without rewriting server behavior.
- [x] Update all 17 HTTP inventory rows to their exact canonical registration
      and command-translation sources; retain server dispatch owners unchanged.
- [x] Prove `registerGroupStateRoutes` installs every route once, every mutation
      type reaches exactly one canonical HTTP registration, and old active
      imports do not reappear.
- [x] Prove OpenAPI, shared-web API integration, black-box workbench/recipes,
      shared DTOs, server production, and middleware production are unchanged.
- [x] Record the PR A one-hop compatibility consumers and removal condition.
- [x] The separately reviewed human decision satisfied this temporary exact-base
      structure ratchet's existing removal condition after PR #70 reached
      `ledger-published`; preserve semantic route, lineage, and active-path
      coverage.
- [x] Independently review navigation accuracy, semantic ratchets, public
      compatibility, and mutation reachability with Critical 0 and Important 0.

### Task 6: Freeze, Review, And Publish PR A

- [x] Review the complete PR A from its exact base for hidden behavior,
      compatibility, authentication, OpenAPI, AppInbox, server, persistence,
      or test changes; runtime cycles; lost assertions; file/function limits;
      generic owners; and extra hops.
- [x] Require Critical 0 and Important 0 and resolve ordinary in-scope findings
      test-first.
- [x] Reconcile the exact-base changed-style review with the two-row lineage
      manifest/provenance audit for mechanically inherited findings and named
      AppInbox-discriminated translator output contracts for all 17 helpers;
      do not grant lineage capacity to semantically new code.
- [x] Run Section 12.2 on one final unchanged tree.
- [x] Freeze the exact tree/commit, push non-forced, update one draft PR A with
      the read-first map and exact evidence, and require Branch Release Gate for
      that exact SHA.
- [x] Mark PR A ready and stop for the human merge decision.
- [x] After human merge, verify exact resulting-main SHA and successful default
      workflow before PR B.

### Task 7: Align The Moved Code Without Changing Behavior

**Files:** only new/moved API-v1 group-state production/tests, the exact active
navigation/ratchet evidence, and the two temporary compatibility files.

- [x] Start PR B from PR A's exact resulting-main SHA after its default
      workflow succeeds; reuse the child goal.
- [x] Add the API-v1 group-state source/style ratchet test-first as temporary
      supplementary evidence with this child as owner and later ledger as
      removal decision point.
- [x] Align descriptive names, imports, named inputs/interfaces, file ordering,
      100-column guidance, 60-line general functions, and 400-line modules.
- [x] Preserve route sequence, fields, object order, defaults, errors, calls,
      results, identity, and side effects exactly.
- [x] Apply Section 7.2. Remove the two temporary re-export files only if every
      removal condition passes; otherwise stop for exact human review.
- [x] Replace no semantic test with a source-string check. Keep source/layout
      ratchets supplementary.
- [x] Independently review PR B with Critical 0 and Important 0.

### Task 8: Freeze, Validate, And Publish PR B

- [x] Run all Task 1-7 focused suites and Section 12.3 on the final unchanged
      tree.
- [x] Reconfirm the mutation-path/concurrency classification and pure-move
      performance exemption. Stop if any fact changed.
- [x] Run every warning-only checker mode and resolve only in-scope new or
      worsened findings without changing checker behavior.
- [x] Freeze exact final tree/commit, push non-forced, update the draft PR with
      current review and validation evidence, and require Branch Release Gate
      success for that exact SHA.
- [x] Mark PR B ready and stop for the exact human merge decision.
- [x] After human merge, verify the exact resulting-main default workflow. Do
      not publish the later ledger in the same tree or task.

### Task 9: Publish The Later Evidence Ledger Separately

- [x] Begin only through a separate human authorization after PR B's exact
      resulting-main default workflow succeeds.
- [x] Update only this child, the master program, and the execution plan unless
      an exact reciprocal record in another active plan is explicitly
      authorized.
- [x] Record completed PR A and PR B implementation envelopes without recording
      the ledger's own future facts inside its tree.
- [x] Publish the ledger through its own branch, draft PR, validation, Branch
      Release Gate, human merge, and exact resulting-main workflow.
- [x] The external final envelope calls this child `ledger-published` and
      unlocks pilot evaluation.

## 11. Independent Human Review Points

1. **Plan review:** approve or request revision of this exact plan Git blob.
2. **Planning merge:** separately merge the exact planning PR; PR A waits for
   its default workflow.
3. **Characterization review:** confirm every current case/literal/assertion and
   all 21 routes/17 commands are accounted for before movement.
4. **Boundary review:** confirm request/default/validation/translation and
   response/error behavior are representation boundaries, not hidden domain
   services.
5. **PR A review:** review the exact structure head/tree, temporary re-exports,
   mirrored tests, navigation, OpenAPI compatibility, and mutation reachability.
6. **PR A merge:** separately authorize only the exact reviewed head/tree.
7. **PR B review:** verify code-standard alignment, compatibility-file removal,
   zero behavior drift, and every final gate.
8. **PR B merge:** separately authorize only the exact reviewed head/tree.
9. **Ledger authorization/merge:** separately authorize and merge the later
   non-circular evidence publication.
10. **Pilot evaluation:** only after this child is `ledger-published`, evaluate
    the complete browser/server/API pilot before choosing Wave 2.

## 12. Validation Matrix

### 12.1 Planning PR

```bash
npx prettier --write \
  plans/api-v1-group-state-route-structure-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md
git diff --check
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

### 12.2 PR A structure-focused gates

```bash
(cd apps/api-v1 && deno test --allow-env --allow-read \
  test/client-state/client-state-mutation-routes.test.ts \
  test/client-state/client-state-read-routes.test.ts \
  test/group-state/group-admission-routes.test.ts \
  test/group-state/group-membership-routes.test.ts \
  test/group-state/group-presence-routes.test.ts \
  test/group-state/group-state-mutation-routes.test.ts \
  test/group-state/group-state-openapi-contract.test.ts \
  test/group-state/group-state-read-routes.test.ts \
  test/group-state/group-state-route-errors.test.ts \
  test/group-state/register-group-state-routes.test.ts \
  test/routes/state-api-cross-feature-routes.test.ts \
  test/rallar-server.test.ts \
  test/swagger-routes.test.ts)
npx vitest run \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/mutation-route-owner-*.test.ts \
  packages/tests/repo/group-state-navigation-map-integrity.test.ts \
  packages/tests/repo/api-v1-group-state-route-structure.test.ts \
  packages/tests/repo/api-v1-group-state-route-lineage-provenance.test.ts
npx vitest run packages/tests/shared-server/group-state
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:rallar-server-hardening
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- <exact-planning-resulting-main-sha>
npx prettier --check \
  apps/api-v1/src/group-state \
  apps/api-v1/src/create-rallar-server.ts \
  apps/api-v1/test/client-state \
  apps/api-v1/test/group-state \
  apps/api-v1/test/routes/state-api-cross-feature-routes.test.ts \
  packages/shared-server/rallar-system/group-state/README.md \
  packages/tests/repo/api-v1-group-state-route-structure.test.ts \
  packages/tests/repo/group-state-navigation-map-integrity.test.ts \
  packages/tests/repo/api-v1-group-state-route-lineage-provenance.test.ts \
  plans/repo-style-lineages/api-v1-group-state-route-structure.json \
  plans/repo-style-lineages/api-v1-group-state-route-structure-provenance.md \
  plans/api-v1-group-state-route-structure-plan.md
git diff --check
npm run test:unit
npm run test:ci
npm run build
```

The executor replaces the explicit placeholder only with the verified planning
PR resulting-main SHA. That future fact is not guessed inside this planning
tree.

### 12.3 PR B final gates

Run every PR A command against the final PR B tree, substituting PR A's exact
resulting-main SHA for the changed-style comparison base, plus:

```bash
test ! -e apps/api-v1/src/routes/group-state-routes.ts
test ! -e apps/api-v1/src/routes/group-state-route-errors.ts
npx vitest run packages/tests/repo/api-v1-group-state-route-lineage-provenance.test.ts
```

The focused test parses supported TypeScript and JavaScript source (`ts`,
`tsx`, `mts`, `cts`, `js`, `mjs`, and `cjs`) and fails for static imports,
re-exports, dynamic `import()`, and `require()` calls that name either
compatibility path, extensionless or with `.ts`. Comments, Markdown, and
ordinary strings are not module specifiers and do not count as active
compatibility evidence. A parsed module specifier blocks compatibility-file
removal until reviewed.

No performance command is required when the exact Section 9 exemption remains
true. If it does not, execution stops for an amended performance protocol
before publication.

## 13. Publication And Non-Circular Completion Evidence

The planning tree may record the already-existing PR #66 envelope. It may not
record its own future tree, commit, PR, Branch Release Gate, merge, or default
workflow.

PR A's frozen tree may record the approved plan and completed local task
evidence, but not its future merge or resulting-main workflow. Those facts stay
in PR A and the Mandatory Completion Handoff external envelope.

PR B's frozen tree may record PR A's already-existing merge/default-workflow
facts and completed local PR B evidence, but not its future merge or
resulting-main workflow.

The later ledger may record the completed planning, PR A, and PR B envelopes.
It may not record the ledger tree, ledger commit, ledger PR, ledger Branch
Release Gate, ledger merge SHA, or ledger default-workflow result before they
exist. Those facts belong to the ledger PR and final external handoff. Only
after that envelope succeeds may this child be `ledger-published`.

Any content change after a review or validation freeze invalidates the affected
review and gates. A later ledger records history; it never relabels an older
implementation tree as having contained future evidence.

## 14. Acceptance Checklist

- [x] Human approved this exact plan Git blob.
- [x] Planning PR merged and its exact resulting-main workflow succeeded.
- [x] All 21 current HTTP routes and all 17 AppInbox mutation mappings were
      characterized before movement.
- [x] Construction/registration and request/runtime timelines remain distinct.
- [x] `registerGroupStateRoutes` is the one descriptive registration entry.
- [x] Every target filename matches its primary symbol and owns one cohesive
      boundary.
- [x] Request-ID precedence, actor overrides, validation order, raw property
      order, and volatile invocation points are exact.
- [x] Authentication, strict reads, route authorization, and error responses
      are exact.
- [x] AppInbox remains the only mutation entry; transaction/retry/persistence
      ownership is unchanged.
- [x] OpenAPI, shared DTOs, browser consumers, black-box recipes, public
      contracts, and persisted contracts are unchanged.
- [x] Every predecessor test case, fixture, literal, expectation, and assertion
      site remains, including the three intact cross-feature cases.
- [x] The final mirrored production/test trees match Section 3.
- [x] PR A's two temporary re-export files are direct, one-hop, and executable-
      logic-free.
- [x] The exact-base lineage manifest/provenance ratchet contains only
      mechanically inherited findings, and each of the 17 translator helpers
      has an AppInbox-discriminated named output contract.
- [x] PR A review has Critical 0 and Important 0; all local and remote gates
      pass for its exact head.
- [x] PR A merged and its exact resulting-main workflow succeeded before PR B.
- [x] PR B removed the temporary files only after every Section 7.2 condition.
- [x] Every new/moved module and materially changed general function meets the
      hard size limits without extra hops.
- [x] PR B review has Critical 0 and Important 0; all local and remote gates
      pass for its exact head.
- [x] PR B merged and its exact resulting-main workflow succeeded.
- [x] The later evidence ledger independently reached `ledger-published`.
- [x] No Wave 2 or broader Wave 3 child began during this child.

## 15. Risks And Stop Conditions

| Risk                                                                                          | Required response                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Route split changes registration order, method, path, or middleware order                     | Restore predecessor order test-first; stop if intentional API change is required.                |
| Translation changes a field, omission, override, property order, or volatile invocation       | Restore exact literal behavior; no semantic cleanup is authorized.                               |
| A helper obscures parse/auth/translate/submit/respond flow                                    | Inline or place the decision in its real named boundary; add no pass-through helper.             |
| Route-level authentication is deduplicated because global middleware already authenticates    | Preserve duplicate predecessor calls; optimization needs separate approval.                      |
| Strict-read or update authorization starts using a different service read                     | Restore exact service method and order; stop for any policy change.                              |
| OpenAPI, browser integration, black-box recipe, or shared DTO must change                     | Stop for a separate public/semantic decision.                                                    |
| AppInbox call becomes fire-and-forget, direct service mutation, or another completion wrapper | Stop and restore the direct awaited canonical completion call.                                   |
| Server production, persistence, transaction, retry, receipt, outbox, or concurrency changes   | Stop; this child does not authorize it or the pure-move performance exemption.                   |
| Test split loses or merges a case, literal, or assertion                                      | Restore exact evidence before movement; source inventories cannot substitute for behavior tests. |
| Client-state extraction causes client production or behavior work                             | Stop; only path/fixture ownership needed to preserve the mixed test is authorized.               |
| A compatibility path requires a second hop or remains actively consumed at PR B removal       | Keep one direct hop and return the exact consumer/removal decision to human review.              |
| Module/function limit drives generic owners or dependency bags                                | Repartition by route family; do not create forwarding layers.                                    |
| New checker, parser, schema, severity, debt, or strictness work appears necessary             | Record an unapproved governance proposal; do not implement it here.                              |
| Required external gate persistently fails                                                     | Stop with exact run/job/step; do not diagnose unrelated provider deployment systems.             |
| Protected unrelated plan hash changes                                                         | Stop and restore the locked file before any publication.                                         |

## 16. Progress Record

| Milestone                    | State                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server prerequisite ledger   | `ledger-published`          | PR #66 feature `6e2ea5e4c727f431743e0ad6eab55a0fc9d9af1b`, tree `111995e3a72eb246fd0b8028aada4fbeda65fe69`, Branch Release Gate `30778763061` attempt 1 success, resulting `main` `04b041824073e50a4f1623ca9a71d0d02b770c12`, default workflow `30780849548` attempt 1 success.                                                                                                                                                                                                                                                            |
| API-v1 child plan            | approved; planning complete | Approved plan blob `00a8efe0e6124ec9882360c1328045cde781b726` plus its authorized PR A amendments remains the scope. Planning PR #67 feature `228f49088b9413aae506086f422849d0d0161554`, tree `0cd117101c165b0bb971e0e1809bf91ca5501461`, resulting `main` `0a52ecee39181c7784fa6b777270f8a59bc33c00`, and default workflow `30785324305` attempt 1 succeeded.                                                                                                                                                                             |
| PR A structure               | complete; PR #68 merged     | Exact base `0a52ecee39181c7784fa6b777270f8a59bc33c00`; feature `cb9f074db23135de682a19108282b95f71b5e54e`, tree `8126969737977c901dc56a35b3b523a9209a4fa7`, Branch Release Gate `30815005047` attempt 1 succeeded, resulting `main` `4d616edc649fe30ebf0fca48db4ab683d9c512e3` has the same tree, and default workflow `30818878869` attempt 1 succeeded for that SHA.                                                                                                                                                                     |
| PR B code-standard alignment | complete; PR #69 merged     | Frozen feature `bcabb62072fa82759e21fc14f6e7efedd7adf00f` and tree `620bb455688ee4f927dd662da0fce01a3c0c7bd9`; final review Critical 0, Important 0, Minor 0; every Section 12.3 local gate passed; Branch Release Gate `30825695539` attempt 2 succeeded; resulting `main` `cff66107dfa13c47e117d9e1dbcfb8f6ae747ea3` has the same tree; default workflow `30833235855` attempt 1 succeeded for that exact SHA. The mutation-path/concurrency classification remained unchanged and the approved pure-move performance exemption applied. |
| API-v1 child later ledger    | `ledger-published`          | PR #70 feature `3ff182f65da7360974ad316033e4dad5eeeb8b12`, tree `8f9502ff3da6a1934e49cbd6d8b6a7508e5e7695`, Branch Release Gate `30861897688` attempt 1 success, resulting `main` `44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`, and default workflow `30864134072` attempt 1 success. A separately reviewed human decision satisfies this temporary ratchet's removal condition; persistent semantic route, lineage, and active-path owners remain.                                                                                          |
| Complete pilot evaluation    | completed; published        | API-v1 child later ledger PR #70 is `ledger-published`; the pilot evaluation conclusions were human-approved at master blob `4172437a6ca3ef6008446a1797582b4e4b9406a9` and execution-plan blob `3dc5495f5ee21b615a44f4e65c92deee8b42a940`.                                                                                                                                                                                                                                                                                                 |

## 17. Planning Self-Review Record

Before planning publication, review the complete plan for:

- missing current or target files and responsibilities;
- placeholders other than exact future resulting-main values that cannot yet
  exist;
- inconsistent filenames, primary symbols, route counts, operation counts, or
  test owners;
- generic ownership, duplicated defaults, hidden service access, extra hops,
  or runtime cycles;
- construction/registration being confused with later runtime invocation;
- indirect or incomplete entry, AppInbox, transaction, completion, response,
  early-exit, failure, or cleanup traces;
- hidden OpenAPI, browser, black-box, public, persisted, authentication,
  authority, AppInbox, persistence, or behavior changes;
- a test move that loses an existing case, fixture, literal, expectation, or
  assertion site;
- a task or review unit too broad for independent human review;
- incomplete mutation-path/concurrency classification or an unjustified
  performance exemption;
- stale server-ledger or API-v1 progress language in reciprocal plans;
- circular future evidence; and
- any unresolved placeholder marker or unnamed implementation choice.

PR A remains one review unit despite exceeding 20 total changed paths because
the production route split and mirrored test split must land together to keep
every active route covered. It is divided into four independently reviewed
cohorts (Tasks 1-5), uses a one-screen read-first map, and keeps semantic/code-
standard alignment in PR B. Splitting route owners across multiple default-
branch publications would leave either duplicate registrations or a mixed
canonical/legacy route owner and would make human tracing worse.

Any unresolved Critical or Important finding returns the exact plan blob to
revision before approval.
