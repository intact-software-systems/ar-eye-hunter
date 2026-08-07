# Rallar Auth Server Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authoritative authentication ownership, security decisions, mutation phases,
transaction exits, credential handling, persistence, and authorization consumers directly
navigable without changing behavior or any public or persisted contract.

**Architecture:** Move the existing auth implementation into one feature-first shared-server
tree with a durable navigation map, direct read/compute/validate/write owners, an explicit
AppInbox handler, and cohesive credential, login, session, and persistence owners. Preserve
package and supported deep-import compatibility through direct one-hop re-exports while
canonical auth code imports its owners directly.

**Tech Stack:** TypeScript 7.0.2, Deno, Vitest, AppInbox, PostgreSQL 16, runtime-state
persistence, Web Crypto, Hono API-v1 consumers, and warning-only repository style tooling.

## Global Constraints

- The human approved this plan at exact Git blob
  `123990bceac9732660e1113101addd5b194d8347`. Execution remains limited to the three
  sequential behavior-neutral implementation PRs and their explicit human merge gates.
- Scope is authoritative shared-server auth ingress, mutation phases, login, credentials,
  sessions, persistence, codecs, validation, proofs, legacy compatibility, mirrored tests, and
  durable navigation. API-v1 and other domain consumers are characterized, not reorganized.
- Preserve every public export, supported deep import, HTTP/OpenAPI contract, public result,
  persisted JSON field and order, storage namespace and key, default, omission, clone, error,
  timing, volatile-value invocation point, and authorization decision.
- Preserve credential secrecy, password and credential digest behavior, session proof, expiry,
  logout/revocation, replay, legacy cutoff, one-use ticket behavior, and error timing.
- Preserve AppInbox registration, queue identity, transaction ownership, retry classification,
  attempts, backoff, fairness, optimistic compare-and-set, durable result, receipts, events,
  required outbox intents, final outbox writes, atomicity, and completion.
- Preserve TypeScript `7.0.2`, dependencies, lockfiles, workflow definitions, warning-only
  checker behavior, and all existing correctness and performance thresholds.
- Preserve `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md` unchanged.
- Do not begin API-v1 auth organization, client-state, topology, RTC/RTT, CRDT, admin, browser,
  checker, dependency, workflow, or semantic-security work in this child.

---

**Program:**
[Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)

**Execution protocol:**
[Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md)

**Predecessor:**
[Rallar Client-State Server Structure Plan](rallar-client-state-server-structure-plan.md)

**Status:** Approved at exact blob `123990bceac9732660e1113101addd5b194d8347`.
Planning PR #76 published feature `38a961c4ee184856422b3acf6f0494d04d8d6e5b`,
passed Branch Release Gate `31103489838` attempt 2, and merged as exact main
`61e708708f94328f095f1f1fa5690747bb933476`, tree
`32fad7c720dcc1eb462f6b486ff64db4f687f67e`. Run Hetzner Supported Distributed
Manifests `31106485616` attempt 1 succeeded for that exact main SHA. PR A Tasks 1-2 are
published and merged through PR #78: final feature
`5118891effa1b9c856154ecab051c2df1b094145`, tree
`0082575cf0697a170c2125cf856ae07fedfe37e2`, Branch Release Gate `31159741601`
attempt 1 success, resulting main `a90042398448776b0972aaaaa0f5cca762163fde`, tree
`9a3084c2c78f90f004054924b99b97be67fe72bd`, and Run Hetzner Supported Distributed
Manifests `31163606362` attempt 1 success for that exact main SHA. Deploy Web + API run
`31163606018` separately failed its Cloudflare main-only branch-control job on that main SHA;
it is not relabeled as the named predecessor gate. PR B draft PR #81 currently publishes its
persistence cohort at `f163c697e7ffb1a35f6db11d802b4a866b02c3e1`, tree
`7ddee320f526e72a4b2cc3eca34d1b73ca355e32`. No future PR B candidate, performance,
merge, resulting-main workflow, PR C, or ledger fact is asserted here.

## 1. Scope, Prerequisite, And Review-Size Decision

### 1.1 Existing prerequisite evidence

The auth child is unblocked by these completed client-state facts:

- ledger PR #75;
- ledger feature `2858bf0c2a9b882a82ae4c33abf58d6e0408be8d`;
- frozen ledger tree `104478f66bcabbbcf101ea97a80d2a2060cb10ec`;
- Branch Release Gate `31097790516`, attempt 2, success for that exact feature;
- resulting `main` `6b75cfc5ec61f81b465be9072b746d24ecdb5f22` with the same tree; and
- Run Hetzner Supported Distributed Manifests `31100952224`, attempt 1, success for that exact
  `main` SHA.

This plan records those existing facts only. It does not reopen the client-state implementation
or its ledger decisions.

### 1.2 Success boundary

The child succeeds when a human can start at login, any auth AppInbox operation, a session proof,
or an authorization consumer and find, by filename, the entry, decode, credential derivation,
read, compute, validate, transaction/write, durable result, public-result reconstruction,
normal exit, early exit, retry, failure, expiry, legacy fallback, cleanup, and caller result.

The durable navigation owner will be
`packages/shared-server/rallar-system/auth/README.md`. It links to source owners and is verified
by semantic path/symbol tests; it does not duplicate runtime truth.

### 1.3 Explicit stacked-PR decision

The 27 auth-owned production files contain 3,849 physical lines. The directly mirrored
shared-server tests and fixtures contain more than 2,300 lines, before API-v1, black-box,
security, lineage, navigation, and compatibility evidence. Moving the existing owners,
splitting phase functions, and preserving old paths is predicted to exceed 100 changed paths or
10,000 additions plus deletions. The feature has five materially distinct control-flow families:
login/registration, durable auth mutations, session/logout lifecycle, ticket issue/consume and
legacy expiry, and proof/authorization queries.

One implementation PR is rejected. After this planning PR, use three sequential PRs:

1. **PR A — mutation and login core:** contracts, codecs, credential derivation, login and
   registration decisions, pure facts/compute/validate owners, semantic tests, and the first
   navigation map.
2. **PR B — authoritative shell and persistence:** repositories, keys, legacy compatibility,
   stable reads, transaction writes, AppInbox handler/service, session/ticket lifecycle, public
   result reconstruction, security/concurrency evidence, and the governed performance gate.
3. **PR C — alignment and final traceability:** align only new/materially rewritten auth owners
   and tests, finish behavior-named mirrored-test ownership, reconcile supported compatibility,
   finalize navigation, and decide every supplementary ratchet.

Each PR starts only after the preceding PR's exact resulting-main SHA passes Run Hetzner
Supported Distributed Manifests. Each receives an independent whole-PR review, Branch Release
Gate, and human merge decision. One child-specific goal is created only after exact plan-blob
approval and is reused across all three PRs.

### 1.4 Pre-authorized private target-tree refinement

Execution may refine a private auth or mirrored-test split, move, name, consolidation, or owner
without another approval only when implementation or independent review proves it is needed for
cohesion, acyclic dependencies, descriptive filename/primary-symbol alignment, a direct call
path, the 400-line module limit, or the 60-line general-function limit.

That authority is behavior-neutral. It may not change a public or persisted contract, security
decision, credential algorithm, compatibility hop, dependency, state, lifecycle, transaction,
retry, authority, storage key, timing event, receipt, event, outbox, or performance rule. The
executor records the factual refinement before the affected PR freezes and reruns every
invalidated gate. Any locked-rule change stops for explicit human approval.

## 2. Current Evidence And Human Baseline

### 2.1 Current concentrated ownership

At the planning base, auth ownership is spread between generic `services/` and
`repositories/`. The largest current files are:

| Current owner                              | Lines | Responsibilities mixed today                                                                                        |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------- |
| `repositories/auth-ticket-persistence.ts`  |   383 | canonical and legacy ticket reads, writes, consume, validation, bounded scan, and session lookup                    |
| `services/auth-state-codecs.ts`            |   361 | command decode, durable-result decode, exact fields, lifecycle, and authority validation                            |
| `repositories/auth-session-persistence.ts` |   355 | canonical/legacy session reads, writes, digest lookup, deletion, decode, and public reconstruction                  |
| `services/auth-state-compute.ts`           |   325 | seven operation decisions, replay/no-op, receipts, sessions, tickets, and logout outbox                             |
| `services/AppAuthInboxService.ts`          |   311 | construction registration, seven public methods, credential issuance, queue identity, phases, and transaction entry |
| `services/auth-login-service.ts`           |   235 | registered/static login, registration validation, PBKDF2 hashing, and constant-time comparison                      |

No auth-owned file currently exceeds 400 lines, but several functions cross the 60-line review
threshold and the folder names do not reveal one auth feature boundary.

### 2.2 Focused warning baseline and required human disposition

A planning-time focused scan of the exact 27 auth-owned files reports 49 warning rows:

| Rule                         | Rows |
| ---------------------------- | ---: |
| `boundary.unknown`           |   28 |
| `line.width`                 |    6 |
| `function.input-contract`    |    3 |
| `function.output-contract`   |    2 |
| `layout.filename-style`      |    2 |
| `layout.primary-export-name` |    8 |

Construction details add no further row for this exact source set. These are warnings, not a
score. Task 1 must capture the exact output on the verified planning resulting-main base, map
every row to its source symbol/span and intended owner, and classify it as mechanically moved,
behavior-neutrally resolved, retained boundary evidence, or blocked on a semantic/security
decision. A human must disposition every row. Exit zero alone is insufficient and no finding
becomes globally blocking.

On 2026-08-06, the human reviewed and approved all 49 proposed dispositions and owner mappings
in the ignored Task 1 report at SHA-256
`804ef9174a91cd33e2d080671657ee3e8d6597c9b65531f1b8c32d93f62dd899`, with no exceptions.

### 2.3 Controlled human navigation sample

Before PR A changes production, a human performs one controlled sample on the exact verified
planning resulting-main SHA. Use the source tree without a prepared answer and record for each
family:

```text
Login and credential issuance:
- elapsed:
- wrong files opened:
- compatibility hops:
- unresolved questions:
- named path and owners:

Authenticated AppInbox mutation:
- elapsed:
- wrong files opened:
- compatibility hops:
- unresolved questions:
- named path and owners:

Logout, expiry, and revocation:
- elapsed:
- wrong files opened:
- compatibility hops:
- unresolved questions:
- named path and owners:

Authentication proof or authorization query:
- elapsed:
- wrong files opened:
- compatibility hops:
- unresolved questions:
- named path and owners:
```

PR C repeats the same sample on its final unchanged tree. The comparison is descriptive; it
must not claim causality or statistical significance. Missing human observations may be waived
only by a separate explicit human amendment and may never be fabricated from code-derived
traces.

For the Task 1 before sample, the human supplied that explicit waiver on 2026-08-06 because no
valid controlled sample was collected. No elapsed times, wrong-file counts, compatibility hops,
unresolved questions, or other human observations exist for that sample. The code-derived family
traces remain qualitative baseline evidence only and support no human-productivity or
navigation-time claim.

## 3. Exact Current Trees And Consumers

### 3.1 Current auth-owned production tree

```text
packages/shared-server/rallar-system/
  services/
    AppAuthInboxService.ts
    auth-app-inbox-routing.ts
    auth-credential-issuer.ts
    auth-login-service.ts
    auth-session-lifecycle.ts
    auth-session-proof-secret.ts
    auth-state-agent-validation.ts
    auth-state-codecs.ts
    auth-state-compute.ts
    auth-state-contracts.ts
    auth-state-errors.ts
    auth-state-mutations.ts
    auth-state-public-results.ts
    auth-state-read.ts
    auth-state-service.ts
    auth-state-validate.ts
    auth-state-validation-shared.ts
    auth-state-write.ts
  repositories/
    AuthSessionRepository.ts
    AuthUserRepository.ts
    auth-legacy-compatibility.ts
    auth-persistence-contracts.ts
    auth-secret-digest.ts
    auth-session-persistence.ts
    auth-session-types.ts
    auth-storage-keys.ts
    auth-ticket-persistence.ts
```

`repositories/session-expiry.ts` is inspected because client/group state use its shared logical
expiry rules, but it is not auth-owned and does not move in this child.

### 3.2 Current composition and authorization consumers, characterized only

```text
packages/shared-server/
  mod.ts
  http/request-auth-service.ts
  http/production-env-hardening.ts
  postgres/rallar-system/createStateRepositories.ts
  rallar-system/middleware/RallarMiddleware.ts
  rallar-system/middleware/rallar-middleware-options.ts
  rallar-system/client-state/**
  rallar-system/group-state/**
  rallar-system/topology/inbox/**
  rallar-system/services/topology-mutation-authority-proof.ts

apps/api-v1/src/
  middleware.ts
  middleware-contract.ts
  repository/createStateRepositories.ts
  repository/login-repository.ts
  routes/config-route.ts
  routes/client-state-routes.ts
  routes/graph-topology-routes.ts
  services/request-auth-service.ts
  services/admin-auth-service.ts
  services/create-api-crdt-document-authorizer.ts
  services/create-api-crdt-inbox-service.ts
  services/ws-topic-room-authorizer.ts
```

Only canonical import-path updates expressly listed in Section 7 may touch these consumers.
Their route, composition, HTTP, CRDT, client/group/topology, and authorization organization and
behavior stay unchanged.

### 3.3 Current mirrored, security, concurrency, and black-box evidence

```text
packages/tests/shared-server/
  app-auth-conflict-inbox.test.ts
  app-auth-inbox-service.test.ts
  app-auth-inbox-test-harness.ts
  app-auth-legacy-cutoff.test.ts
  app-auth-legacy-replay-inbox.test.ts
  app-auth-persistence-inbox.test.ts
  app-auth-public-routing-inbox.test.ts
  app-auth-transaction-inbox.test.ts
  auth-fixture.ts
  auth-login-service.test.ts
  request-auth-service.test.ts

apps/api-v1/test/
  config-route-auth-logout.test.ts
  request-admin-auth-service.test.ts
  request-auth-service.test.ts
  routes/agent-session-ticket-route.test.ts
  services/ws-topic-room-authorizer.test.ts
  db/pglite-auth-app-inbox.test.ts
  db/pglite-auth-failure-atomicity.test.ts
  db/pglite-auth-test-harness.ts
  db/pglite-auth-transaction-rollback.test.ts
  db/pglite-crdt-ws-authority-correction-4.test.ts

packages/tests/rallar-black-box/
  auth-flow.test.ts
  auth-lifecycle.test.ts

packages/shared-test/black-box-runner/
  examples/rallar-server-auth-group-ws-smoke.json
  examples/rallar-server-negative-auth.json
  examples/rallar-server-register-login.json
  tests/api-v1/api-v1-auth-session.json
  tests/api-v1/api-v1-black-box-control-auth.json
  tests/api-v1/api-v1-openapi-topology-auth.json
```

The cross-domain mutation routing, AppInbox retry/exhaustion, client/group authority,
PostgreSQL worker, medium-scale convergence, and shared public-contract suites remain active
compatibility evidence even when they are not moved.

## 4. Exact Target Production Tree And Ownership

### 4.1 Target tree

```text
packages/shared-server/rallar-system/auth/
  README.md
  auth-mutation-service.ts
  credentials/
    auth-credential-issuer.ts
    hash-auth-secret.ts
  inbox/
    app-auth-inbox-service.ts
    auth-app-inbox-routing.ts
    auth-inbox-handler.ts
  login/
    authenticate-auth-user.ts
    prepare-auth-user-registration.ts
  mutation/
    auth-mutation-contracts.ts
    auth-mutation-rejected-error.ts
    decode-auth-mutation-command.ts
    decode-auth-mutation-result.ts
    to-auth-mutation-public-result.ts
    read/
      capture-auth-mutation-facts.ts
      read-auth-mutation.ts
      read-auth-session-entries.ts
    compute/
      to-auth-logout-outbox.ts
      compute-auth-mutation.ts
      compute-auth-user-registration.ts
      compute-auth-session-mutation.ts
      compute-auth-ticket-mutation.ts
      compute-auth-agent-ticket-mutation.ts
    validate/
      auth-mutation-validation.ts
      validate-auth-mutation.ts
      validate-auth-user-mutation.ts
      validate-auth-session-mutation.ts
      validate-auth-ticket-mutation.ts
      validate-auth-agent-ticket-mutation.ts
    write/
      write-auth-mutation.ts
      write-auth-session.ts
      write-auth-ticket-mutation.ts
  persistence/
    auth-legacy-compatibility.ts
    auth-persistence-contracts.ts
    auth-session-persistence.ts
    auth-session-repository.ts
    auth-session-types.ts
    auth-storage-keys.ts
    auth-ticket-persistence.ts
    auth-user-repository.ts
  sessions/
    auth-session-proof-secret.ts
    require-issue-session-lifecycle.ts

packages/shared-server/rallar-system/
  services/
    AppAuthInboxService.ts          # direct one-hop compatibility only
    auth-credential-issuer.ts       # direct one-hop compatibility only
    auth-login-service.ts           # direct one-hop compatibility only
    auth-state-mutations.ts         # direct named one-hop compatibility only
  repositories/
    AuthSessionRepository.ts        # direct named one-hop compatibility only
    AuthUserRepository.ts           # direct named one-hop compatibility only
```

No nested barrel or second compatibility hop is added. Old private files not shown as
compatibility owners are removed after active-import tests prove no repository consumer remains.

#### Current PR A production tree

PR A currently owns exactly this canonical subset:

```text
packages/shared-server/rallar-system/auth/
  README.md
  auth-mutation-service.ts
  credentials/
    auth-credential-issuer.ts
    hash-auth-secret.ts
  login/
    authenticate-auth-user.ts
    prepare-auth-user-registration.ts
  mutation/
    auth-mutation-contracts.ts
    auth-mutation-rejected-error.ts
    decode-auth-mutation-command.ts
    decode-auth-mutation-result.ts
    to-auth-mutation-public-result.ts
    read/
      capture-auth-mutation-facts.ts
    compute/
      to-auth-logout-outbox.ts
      compute-auth-agent-ticket-mutation.ts
      compute-auth-mutation.ts
      compute-auth-session-mutation.ts
      compute-auth-ticket-mutation.ts
      compute-auth-user-registration.ts
    validate/
      auth-mutation-validation.ts
      validate-auth-agent-ticket-mutation.ts
      validate-auth-mutation.ts
      validate-auth-session-mutation.ts
      validate-auth-ticket-mutation.ts
      validate-auth-user-mutation.ts
  sessions/
    auth-session-proof-secret.ts
    require-issue-session-lifecycle.ts
```

The still-current AppInbox service/routing, stable read, transaction write, session/user
repository, persistence, storage-key, legacy, and issued-session owners remain at their
Section 3.1 predecessor paths. Their target-path and re-export-only assertions are deferred to
PR B; PR A semantic tests continue to exercise those predecessor owners directly.

PR A also temporarily restores `services/auth-state-codecs.ts` as a direct named re-export of
the two canonical decoders. It exists only because the approved one-to-many structural-lineage
validator requires the exact predecessor path in the target tree. Canonical auth code does not
import it. `services/auth-state-read.ts` remains PR B's executable read owner while directly
exporting the predecessor `captureAuthMutationFacts` binding as the exact canonical runtime
identity.

### 4.2 Primary symbol and responsibility contract

| Target file                                                | Primary owner                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `auth-mutation-service.ts`                                 | primary `AuthMutationService` declaration followed by `createAuthMutationService` composition                        |
| `inbox/app-auth-inbox-service.ts`                          | public `AppAuthInboxService` enqueue/completion surface and registration                                             |
| `inbox/auth-inbox-handler.ts`                              | `AuthInboxHandler.processAuthMutation` runtime phase/transaction sequence                                            |
| `inbox/auth-app-inbox-routing.ts`                          | `toAuthAppInboxType`, `toAuthCommandContextId`, and `toAuthCommandSenderId`                                          |
| `credentials/auth-credential-issuer.ts`                    | `AuthCredentialIssuer` and HMAC credential derivation                                                                |
| `credentials/hash-auth-secret.ts`                          | `hashAuthSecret` only                                                                                                |
| `login/authenticate-auth-user.ts`                          | registered/static credential authentication and constant-time comparison                                             |
| `login/prepare-auth-user-registration.ts`                  | username/password/display-name validation and PBKDF2 user construction                                               |
| `mutation/auth-mutation-contracts.ts`                      | `AuthMutationCommand`, `AuthMutationRead`, `AuthMutationComputed`, `AuthMutationResult`, and public-result contracts |
| `mutation/auth-mutation-rejected-error.ts`                 | `AuthMutationRejectedError`                                                                                          |
| `mutation/decode-auth-mutation-command.ts`                 | strict command decode and exact discriminated fields                                                                 |
| `mutation/decode-auth-mutation-result.ts`                  | strict durable-result decode and exact property/lifecycle rules                                                      |
| `mutation/to-auth-mutation-public-result.ts`               | digest-checked plaintext reconstruction after durable completion                                                     |
| `mutation/read/capture-auth-mutation-facts.ts`             | deterministic credential/digest fact verification                                                                    |
| `mutation/read/read-auth-mutation.ts`                      | visible read-family router                                                                                           |
| `mutation/read/read-auth-session-entries.ts`               | `readAuthSessionEntries` canonical/legacy index pair                                                                 |
| `mutation/compute/compute-auth-mutation.ts`                | exhaustive pure operation router                                                                                     |
| `mutation/compute/compute-auth-user-registration.ts`       | `computeAuthUserRegistration`                                                                                        |
| `mutation/compute/compute-auth-session-mutation.ts`        | `computeAuthSessionMutation`                                                                                         |
| `mutation/compute/compute-auth-ticket-mutation.ts`         | `computeAuthTicketMutation`                                                                                          |
| `mutation/compute/compute-auth-agent-ticket-mutation.ts`   | `computeAuthAgentTicketMutation`                                                                                     |
| `mutation/compute/to-auth-logout-outbox.ts`                | `toAuthLogoutOutbox` exact `WS_OUTBOX` intent                                                                        |
| `mutation/validate/validate-auth-mutation.ts`              | exhaustive validation-family router                                                                                  |
| `mutation/validate/auth-mutation-validation.ts`            | shared exact-kind/session/ticket/JSON validation                                                                     |
| `mutation/validate/validate-auth-user-mutation.ts`         | `validateAuthUserMutation`                                                                                           |
| `mutation/validate/validate-auth-session-mutation.ts`      | `validateAuthSessionMutation`                                                                                        |
| `mutation/validate/validate-auth-ticket-mutation.ts`       | `validateAuthTicketMutation`                                                                                         |
| `mutation/validate/validate-auth-agent-ticket-mutation.ts` | `validateAuthAgentTicketMutation`                                                                                    |
| `mutation/write/write-auth-mutation.ts`                    | exhaustive transaction-write router                                                                                  |
| `mutation/write/write-auth-session.ts`                     | two-index conditional session write/delete                                                                           |
| `mutation/write/write-auth-ticket-mutation.ts`             | `writeAuthTicketMutation` conditional insert/consume                                                                 |
| `persistence/auth-session-repository.ts`                   | `AuthSessionRepository` public session/ticket capability                                                             |
| `persistence/auth-user-repository.ts`                      | `AuthUserRepository` and `normalizeUsername`                                                                         |
| `persistence/auth-session-persistence.ts`                  | `AuthSessionPersistence` row and conditional-delete owner                                                            |
| `persistence/auth-ticket-persistence.ts`                   | `AuthTicketPersistence` one-use/legacy ticket owner                                                                  |
| `persistence/auth-persistence-contracts.ts`                | `PersistedAuthSession`, ticket contracts, and their exact decode functions                                           |
| `persistence/auth-session-types.ts`                        | `IssuedAuthSession`, `IssuedWebSocketTicket`, and `IssuedAgentSessionTicket`                                         |
| `persistence/auth-storage-keys.ts`                         | exact namespace constants and `auth*Key` functions                                                                   |
| `persistence/auth-legacy-compatibility.ts`                 | deadline/limit constants, `isLegacyPlaintextCompatibilityActive`, and `readBoundedLegacyAuthPage`                    |
| `sessions/require-issue-session-lifecycle.ts`              | `requireIssueSessionLifecycle`                                                                                       |
| `sessions/auth-session-proof-secret.ts`                    | `authSessionProofSecret`                                                                                             |

Every general function or callback remains at most 60 physical lines and every module at most 400. A split must own a decision, lifecycle, persistence operation, or protocol translation; a
line-limit-only forwarding helper is rejected.

### 4.3 Complete current-to-target production map

| Current file                                 | Exact target owner(s)                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/AppAuthInboxService.ts`            | `inbox/app-auth-inbox-service.ts`; `inbox/auth-inbox-handler.ts`; old path becomes one-hop compatibility                                                                                       |
| `services/auth-app-inbox-routing.ts`         | `inbox/auth-app-inbox-routing.ts`                                                                                                                                                              |
| `services/auth-credential-issuer.ts`         | `credentials/auth-credential-issuer.ts`; old path becomes one-hop compatibility                                                                                                                |
| `services/auth-login-service.ts`             | `login/authenticate-auth-user.ts`; `login/prepare-auth-user-registration.ts`; old path becomes one-hop compatibility                                                                           |
| `services/auth-session-lifecycle.ts`         | `sessions/require-issue-session-lifecycle.ts`                                                                                                                                                  |
| `services/auth-session-proof-secret.ts`      | `sessions/auth-session-proof-secret.ts`                                                                                                                                                        |
| `services/auth-state-agent-validation.ts`    | `mutation/validate/validate-auth-agent-ticket-mutation.ts`                                                                                                                                     |
| `services/auth-state-codecs.ts`              | `mutation/decode-auth-mutation-command.ts`; `mutation/decode-auth-mutation-result.ts`; PR A old path temporarily re-exports both canonical identities for exact one-to-many lineage validation |
| `services/auth-state-compute.ts`             | compute router; four compute family owners; `to-auth-logout-outbox.ts`                                                                                                                         |
| `services/auth-state-contracts.ts`           | `mutation/auth-mutation-contracts.ts`                                                                                                                                                          |
| `services/auth-state-errors.ts`              | `mutation/auth-mutation-rejected-error.ts`; digest check moves beside captured facts/public projection                                                                                         |
| `services/auth-state-mutations.ts`           | old path remains direct named compatibility exports to canonical mutation/service owners                                                                                                       |
| `services/auth-state-public-results.ts`      | `mutation/to-auth-mutation-public-result.ts`                                                                                                                                                   |
| `services/auth-state-read.ts`                | read router; `capture-auth-mutation-facts.ts`; `read-auth-session-entries.ts`                                                                                                                  |
| `services/auth-state-service.ts`             | `auth/auth-mutation-service.ts`                                                                                                                                                                |
| `services/auth-state-validate.ts`            | validation router and user/session/ticket family owners                                                                                                                                        |
| `services/auth-state-validation-shared.ts`   | `mutation/validate/auth-mutation-validation.ts`                                                                                                                                                |
| `services/auth-state-write.ts`               | write router; `write-auth-session.ts`; `write-auth-ticket-mutation.ts`                                                                                                                         |
| `repositories/AuthSessionRepository.ts`      | `persistence/auth-session-repository.ts`; old path becomes one-hop compatibility                                                                                                               |
| `repositories/AuthUserRepository.ts`         | `persistence/auth-user-repository.ts`; old path becomes one-hop compatibility                                                                                                                  |
| `repositories/auth-legacy-compatibility.ts`  | `persistence/auth-legacy-compatibility.ts`                                                                                                                                                     |
| `repositories/auth-persistence-contracts.ts` | `persistence/auth-persistence-contracts.ts`                                                                                                                                                    |
| `repositories/auth-secret-digest.ts`         | `credentials/hash-auth-secret.ts`                                                                                                                                                              |
| `repositories/auth-session-persistence.ts`   | `persistence/auth-session-persistence.ts`                                                                                                                                                      |
| `repositories/auth-session-types.ts`         | `persistence/auth-session-types.ts`                                                                                                                                                            |
| `repositories/auth-storage-keys.ts`          | `persistence/auth-storage-keys.ts`                                                                                                                                                             |
| `repositories/auth-ticket-persistence.ts`    | `persistence/auth-ticket-persistence.ts`                                                                                                                                                       |

### 4.4 Acyclic dependency direction

The target dependency direction is:

```text
shared API contracts
  -> auth persistence contracts / credential primitives
  -> auth mutation contracts
  -> read / compute / validate / write family owners
  -> auth mutation service
  -> auth inbox handler
  -> AppAuthInboxService registration and public enqueue/completion
  -> middleware and API/domain consumers
```

Login depends on the canonical user repository and mutation authority type, but mutation and
persistence never import login. Persistence never imports mutation, service, inbox, API-v1, or
compatibility modules. The handler receives named service, credential, and transaction
capabilities; it does not create repositories, read environment state, or depend on mutable
setters. Compatibility modules import canonical owners only and canonical auth code never
imports them.

## 5. Exact Target Test And Evidence Tree

### 5.1 Target mirrored test tree

```text
packages/tests/shared-server/auth/
  auth-app-inbox-test-runtime.ts
  auth-command-and-result-codecs.test.ts
  auth-credential-login.test.ts
  auth-inbox-registration-and-routing.test.ts
  auth-legacy-cutoff.test.ts
  auth-legacy-replay.test.ts
  auth-persistence-security.test.ts
  auth-public-command-routing.test.ts
  auth-request-proof.test.ts
  auth-ticket-conflict.test.ts
  auth-transaction-boundary.test.ts
  auth-test-fixtures.ts

packages/tests/repo/
  auth-server-lineage-provenance.test.ts
  auth-server-navigation-map-integrity.test.ts
  auth-server-ownership.test.ts
  auth-server-source-ratchet.test.ts
  auth-server-test-ownership.test.ts
```

The API-v1 and black-box test paths in Section 3.3 remain in place. Historical test names are
not preserved merely to describe the migration task.

#### Current PR A test and evidence tree

```text
packages/tests/shared-server/auth/
  auth-command-and-result-codec-regressions.test.ts
  auth-command-and-result-codecs.test.ts
  auth-credential-login.test.ts
  auth-legacy-replay.test.ts
  auth-logout-outbox.test.ts
  auth-mutation-agent-compute-order.test.ts
  auth-mutation-compute-evaluation-order.test.ts
  auth-mutation-compute.test.ts
  auth-mutation-facts.test.ts
  auth-mutation-router-evaluation-order.test.ts
  auth-mutation-service.test.ts
  auth-mutation-validation-early-exit.test.ts
  auth-mutation-validation.test.ts
  auth-persistence-security.test.ts
  auth-public-command-routing.test.ts
  auth-public-result.test.ts
  auth-request-proof.test.ts

packages/tests/repo/
  auth-server-lineage-provenance.test.ts
  auth-server-navigation-map-integrity.test.ts
  auth-server-ownership.test.ts
  auth-server-pr-a-lineage-inventory.ts
  auth-server-test-ownership.test.ts
```

These are PR A's stage-accurate owners. The final Section 5.1 consolidation remains reserved
for PR B/PR C where the mixed predecessor AppInbox, persistence, conflict, legacy-cutoff, and
transaction suites actually move. No PR A completion test requires a future path.

### 5.2 Complete mirrored-test move map

| Current test/support owner              | Target owner                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app-auth-inbox-test-harness.ts`        | `auth/auth-app-inbox-test-runtime.ts`                                                                                                  |
| `auth-fixture.ts`                       | `auth/auth-test-fixtures.ts`                                                                                                           |
| `app-auth-inbox-service.test.ts`        | codec cases to `auth-command-and-result-codecs.test.ts`; registration/lifecycle cases to `auth-inbox-registration-and-routing.test.ts` |
| `app-auth-conflict-inbox.test.ts`       | `auth/auth-ticket-conflict.test.ts`                                                                                                    |
| `app-auth-legacy-cutoff.test.ts`        | `auth/auth-legacy-cutoff.test.ts`                                                                                                      |
| `app-auth-legacy-replay-inbox.test.ts`  | `auth/auth-legacy-replay.test.ts`                                                                                                      |
| `app-auth-persistence-inbox.test.ts`    | `auth/auth-persistence-security.test.ts`                                                                                               |
| `app-auth-public-routing-inbox.test.ts` | `auth/auth-public-command-routing.test.ts`                                                                                             |
| `app-auth-transaction-inbox.test.ts`    | `auth/auth-transaction-boundary.test.ts`                                                                                               |
| `auth-login-service.test.ts`            | `auth/auth-credential-login.test.ts`                                                                                                   |
| `request-auth-service.test.ts`          | `auth/auth-request-proof.test.ts`                                                                                                      |

Every existing case, fixture value, raw literal, mutation, expectation, and assertion site is
preserved. Splits may move directly owned setup but may not merge away cases, replace semantic
assertions with source text, or create a generic test runtime.

### 5.3 Semantic evidence and supplementary ratchets

Semantic tests are primary:

- every command kind reaches one canonical read/compute/validate/write or early-exit owner;
- AppInbox registration and later invocation are distinct and complete;
- queue identities, retry re-entry, transaction ownership, durable result, logout outbox, and
  completion are exact;
- credential plaintext is never persisted in canonical rows or durable results;
- password, HMAC, digest, ticket, expiry, replay, legacy cutoff, and authorization behavior is
  exact;
- supported compatibility files contain re-exports only and canonical auth imports bypass them;
- the target graph remains acyclic and filenames match primary symbols.

Exact file, line, symbol, source-span, or inventory ratchets are supplementary. This auth child
owns them. PR C records whether each is removed, replaced by a semantic owner, or retained with
a reason. The later ledger records that existing decision; it does not invent one.

## 6. Construction, Registration, And Runtime Traces

### 6.1 Current construction and registration timeline

```text
apps/api-v1/src/middleware.ts initialise
  -> createRuntimeStateRepository
  -> createAuthSessionRepository
  -> createHmacAuthCredentialIssuer(readRequiredAuthCredentialSecret())
  -> createRallarMiddleware
  -> RallarMiddleware invokes createAppAuthInboxService
  -> createAuthMutationService(runtimeRepository, serviceId)
  -> new AppAuthInboxService(... nine positional dependencies ...)
  -> AppAuthInboxService constructor calls super
  -> constructor loops seven AUTH_TYPES
  -> onStateMessage registers processCommand callbacks with InboxQueueReader
```

Registration makes handlers callable later; it does not process a request. Required auth
dependencies already exist before the seven callbacks register, and that ordering is preserved.

### 6.2 Target construction and registration timeline

```text
API-v1 composition constructs runtime repository and credential issuer
  -> createAuthMutationService({ runtimeRepository, serviceId })
  -> new AuthInboxHandler({ mutationService, credentialIssuer, transactionWriter })
  -> new AppAuthInboxService(existing public constructor inputs)
  -> register seven exact AppInboxType callbacks
  -> each callback invokes the already-complete AuthInboxHandler later
```

The public constructor signature remains exact. Any private factory/named-input refinement must
remain behind it and may not change construction order, defaults, identity, or registration.

### 6.3 Login and credential issuance trace

Current:

```text
POST /api/auth/login
  -> config-route init handler / rate limits / JSON body
  -> login-repository.login
  -> authenticateAuthUser
  -> AuthUserRepository.findByNormalizedUsernameEntry
  -> status + PBKDF2 verify + constantTimeEqual OR configured static-client comparison
  -> undefined -> identical 401 invalid-credential response
  -> AppAuthInboxService.issueSession
  -> credentialIssuer.issueAccessToken -> hashAuthSecret
  -> processAuthCommandUntilCompletion
  -> later durable AppInbox trace in Section 6.4
  -> toAuthMutationPublicResult rederives token and verifies digest
  -> LoginResponse JSON
```

Target uses the same steps through
`login/authenticate-auth-user.ts`, `credentials/auth-credential-issuer.ts`, the named inbox
handler, and `mutation/to-auth-mutation-public-result.ts`. Registration follows the parallel
`prepareAuthUserRegistration -> registerUser` path. No refresh operation exists today; this
child preserves that absence and does not introduce one.

### 6.4 Authenticated AppInbox mutation trace

Current representative session issue:

```text
API caller -> AppAuthInboxService.issueSession
  -> derive plaintext access token and persist only its digest in command
  -> decodeAuthMutationCommand
  -> toAuthAppInboxType/contextId/senderId
  -> AppInboxService.processEntryUntilCompletionResult
  -> enqueue, wake, wait
  -> later InboxQueueReader invokes registered callback
  -> AppInboxService validates command identity and begins finalization
  -> AppAuthInboxService.processCommand
  -> decode command and compare queue key/type
  -> AuthMutationService.read
  -> captureAuthMutationFacts and digest verification
  -> compute -> validate
  -> AppInboxTransactionWriter.writeMutation
  -> runInTransaction
  -> write auth rows by optimistic compare-and-set
  -> replace durable result and mark inbox completed in the same transaction
  -> caller reads durable result
  -> decodeAuthMutationResult
  -> reconstruct/verify public credential
  -> Either right public result
```

Retryable optimistic conflicts release the queue entry; later delivery re-enters decode, read,
facts, compute, validate, and transaction with current state. Terminal validation/security
errors persist a failed result. Missing completion returns unavailable; a missing durable result
throws. The target makes the same boundaries visible in matching files without changing them.

### 6.5 Session lifecycle, logout, expiry, and revocation trace

```text
issue-session -> requireIssueSessionLifecycle -> write token/session indexes with same expiry
request proof -> runtime-state read removes/omits expired value -> unauthorized
logout route -> requireApiAuthSession -> AppAuthInboxService.logoutSession
  -> read both indexes, validate exact authority
  -> compute no-op when both already absent OR create logout WS_OUTBOX intent
  -> one transaction conditionally deletes both indexes, writes logout outbox,
     persists durable result, and completes AppInbox
  -> normal loggedOut result; retry on optimistic conflict
legacy canonical miss before 2026-12-31 -> bounded legacy lookup, strict decode, digest check
legacy cutoff or expiry -> unavailable/unauthorized without a widened fallback
generic runtime-state expiry cleanup -> physical expired-row cleanup outside auth decisions
```

Logout is the current explicit revocation path. There is no session refresh command and no
auth-owned eager expiry maintenance AppInbox operation. The plan preserves those facts rather
than inventing owners. Shared `repositories/session-expiry.ts` remains outside this auth move.

### 6.6 Ticket issue and consume trace

```text
authenticated caller -> issue ws/agent ticket public method
  -> deterministic HMAC plaintext + digest-only command
  -> read live parent session and existing/expired ticket rows
  -> validate parent authority, lifecycle, digest collision, and legacy rules
  -> conditionally insert canonical digest-key ticket (and agent session indexes when applicable)
  -> durable digest-only receipt -> reconstruct plaintext after completion

consumer -> digest presented ticket -> read canonical or bounded legacy row
  -> validate expiry, expected session/client/access-token authority
  -> transaction conditionally deletes ticket exactly once
  -> durable consumed-session receipt -> reconstruct access token after completion
```

Concurrent consumption permits exactly one successful conditional delete. Corrupt or expired
records fail before destructive mutation. Those exits remain primary security tests.

### 6.7 Authentication and authorization proof/query trace

```text
HTTP request -> requireApiAuthSession
  -> parse Bearer header, then x-client-id
  -> AuthSessionRepository.findByAccessToken
  -> hashAuthSecret -> canonical digest-key read -> strict decode/expiry
  -> bounded legacy plaintext fallback only while cutoff is active
  -> compare session.clientId -> return IssuedAuthSession or timed unauthorized error

WebSocket upgrade -> requireWsAuthSession
  -> AppAuthInboxService.consumeWebSocketTicket -> one-use durable trace

group/client/topology/CRDT/admin/topic-room consumers
  -> findBySessionId or authSessionProofSecret
  -> existing domain-specific authorization decision
```

The target moves the canonical auth proof and persistence owners only. Domain-specific
authorization policies remain in their existing domains and are compatibility-verified, not
reorganized.

## 7. Ownership, Compatibility, And Locked Security Invariants

### 7.1 Exact ownership decisions

| Responsibility                                             | Canonical owner                                        |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| AppInbox public enqueue/completion and seven registrations | `inbox/app-auth-inbox-service.ts`                      |
| later queue invocation and phase/transaction sequence      | `inbox/auth-inbox-handler.ts`                          |
| strict command/result decode                               | two `mutation/decode-*` owners                         |
| registered/static login and password proof                 | `login/authenticate-auth-user.ts`                      |
| registration validation and password hashing               | `login/prepare-auth-user-registration.ts`              |
| HMAC plaintext derivation                                  | `credentials/auth-credential-issuer.ts`                |
| SHA-256 secret digest                                      | `credentials/hash-auth-secret.ts`                      |
| read/facts/compute/validate/write                          | matching phase and family files under `mutation/`      |
| public credential reconstruction                           | `mutation/to-auth-mutation-public-result.ts`           |
| user index persistence                                     | `persistence/auth-user-repository.ts`                  |
| session/ticket public persistence capability               | `persistence/auth-session-repository.ts`               |
| session and ticket row mechanics                           | respective persistence files                           |
| persisted schemas and strict cloning                       | `persistence/auth-persistence-contracts.ts`            |
| namespaces and keys                                        | `persistence/auth-storage-keys.ts`                     |
| bounded legacy deadline/scan                               | `persistence/auth-legacy-compatibility.ts`             |
| API request/admin/CRDT/room authorization                  | existing API/domain owners; unchanged                  |
| transaction, retry, durable result, terminal failure       | existing `AppInboxTransactionWriter`/`AppInboxService` |

Auth has no separate domain event store or idempotency record. The physical AppInbox command,
queue key, durable result, and completion row are its existing idempotency/receipt evidence.
Only logout creates a final auth-owned `WS_OUTBOX` intent. The plan preserves those absences.

### 7.2 Direct one-hop compatibility inventory

| Old path                                | Known production consumers retained initially                                                                                      | Owner and removal condition                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `services/AppAuthInboxService.ts`       | API middleware/contracts/config route, shared middleware options, shared HTTP WS auth                                              | auth child; remove only after API/shared consumers adopt a separately approved path or a breaking release |
| `services/auth-state-mutations.ts`      | package `mod.ts`, API middleware, shared public-contract tests                                                                     | auth child; direct named re-export remains until supported public/deep imports are separately migrated    |
| `services/auth-login-service.ts`        | package `mod.ts`, API login repository                                                                                             | auth child; remove in a future API-v1 auth child plus public compatibility decision                       |
| `services/auth-credential-issuer.ts`    | package `mod.ts`, API middleware, production-env hardening                                                                         | auth child; remove only after package/API consumers migrate with explicit compatibility approval          |
| `repositories/AuthSessionRepository.ts` | package `mod.ts`, API repository/routes/auth, shared HTTP, client/group/topology owners, PostgreSQL factories, performance harness | auth child; preserve until all cross-domain and public consumers receive separate approved migration      |
| `repositories/AuthUserRepository.ts`    | package `mod.ts`, API repositories, PostgreSQL factory                                                                             | auth child; preserve until public/API consumers receive separate approved migration                       |

`packages/shared-server/mod.ts` exports canonical AppAuth symbols directly while each retained
old supported path remains one direct re-export hop. Canonical auth code and moved auth tests do
not import supported old paths. The temporary codec wrapper has been removed after its active-
consumer scan found no supported consumer.

PR B moves `readAuthMutation` and `writeAuthMutation` to canonical phase owners.
`services/auth-state-mutations.ts` keeps the supported direct identity binding for
`captureAuthMutationFacts`; the private predecessor read, write, and routing files are removed
without wrappers after their active consumers move.

The following non-public old files receive no lasting compatibility wrapper after their exact
active consumers move: `auth-app-inbox-routing`, session lifecycle/proof, validation, codecs, read,
compute, validate, write, persistence contracts/types/keys, secret digest, session persistence,
ticket persistence, and legacy compatibility. Cross-domain imports of proof, persisted session
contracts, and session types may receive import-path-only updates; if an active consumer cannot
move without behavior or organization changes, keep one direct re-export, record that exact
consumer and removal condition, and stop for human review.

### 7.3 Locked security and persistence invariants

- Password records remain PBKDF2-SHA-256 with 120,000 iterations, 256 bits, a 16-byte random
  salt, exact base64 encoding, and the existing constant-time byte comparison.
- Registered and configured-static login order, username normalization/pattern/length,
  password/display-name limits, active status, generic invalid-credential response, and static
  username collision behavior remain exact.
- HMAC credentials retain the `rallar-auth-credential-v1` domain, purposes, identity arrays,
  SHA-256, 32-character minimum secret, trim behavior, and base64url encoding.
- Canonical persisted sessions/tickets contain digests, never plaintext credentials. Durable
  AppInbox results also contain digests only. Public plaintext is rederived only after confirmed
  durable completion and checked against the digest.
- Namespaces remain `auth-users:by-username`, `auth-users:by-client-id`,
  `auth-sessions:by-token`, `auth-sessions:by-session`, `auth-sessions:ws-tickets`, and
  `auth-sessions:agent-session-tickets`.
- Key prefixes remain `username`, `client`, `token-digest`, `token`, `session`,
  `ticket-digest`, and `ticket` with the same URI encoding.
- Strict exact-field validation, property order, cloning, timestamps, expiry, identity checks,
  corruption errors, and canonical-before-legacy read order remain exact.
- Legacy plaintext compatibility keeps deadline `2026-12-31T00:00:00.000Z`, scan limit 128,
  bounded paging, no unbounded fallback, and fail-closed cutoff behavior.
- WebSocket and agent tickets remain single-use, session/client-bound, expiry-bound, and
  conditionally deleted by exact revision.
- Queue type/context/sender/resource identity, command decode timing, transaction retry, no-op
  logout, logout outbox JSON and property order, receipt, terminal failure, and caller-visible
  errors remain exact.
- API request auth keeps Bearer parsing before `x-client-id`, canonical then legacy lookup,
  client-id match, and existing unauthorized wording/timing. Admin, CRDT, group, client,
  topology, room/topic, and WebSocket authorization decisions remain with current owners.

## 8. Structural, Alignment, And Semantic Boundaries

### 8.1 PR A permitted work

- Add characterization, protocol, security, public-result, and navigation tests first.
- Move/split auth mutation contracts, strict codecs, credential/login decisions, facts,
  compute, and validation into the target tree.
- Add the first code-derived README and direct one-hop compatibility exports.
- Preserve I/O, repository, AppInbox, and API behavior exactly.

### 8.2 PR B permitted work

- Move/split auth repositories, persisted contracts, keys, legacy readers, read/write phases,
  public result projection, service composition, AppInbox registration, and handler ownership.
- Update direct imports only where needed for the canonical path.
- Preserve every transaction, retry, credential, security, persistence, and caller contract.

### 8.3 PR C permitted work

- Align only new or materially rewritten auth production/tests/evidence.
- Finish behavior-named test moves, direct imports, README traces, line/function/module limits,
  and supplementary-ratchet decisions.
- Remove an old private file only after active imports prove the Section 7 condition.

### 8.4 Not approved

No PR may change an algorithm, credential format, password policy, session/ticket lifecycle,
legacy deadline/limit, API/OpenAPI behavior, authorization policy, AppInbox semantic, persisted
format/key, dependency, workflow, checker behavior, TypeScript version, or performance threshold.
No new refresh, revoke, role, admin, CRDT, topology, RTC, browser, or API feature is introduced.
Any such need stops for separate explicit human approval.

## 9. Implementation Tasks

### Task 0: Publish And Approve This Plan

**Files:** the four planning files authorized by the planning request.

- [x] Format the four plans, run planning governance and repository completion gates, and
      perform the Section 17 self-review.
- [x] Freeze the exact tree, commit on `codex/rallar-auth-server-structure-plan`, push
      non-forced, open one draft planning PR, and require Branch Release Gate for its exact head.
- [x] Stop for human review and explicit approval or revision of the exact auth plan Git blob.
- [x] After manual merge, require the exact resulting-main Run Hetzner Supported Distributed
      Manifests workflow before creating the one child-specific goal or PR A branch.

### Task 1: Characterize Before Editing

**Files:**

- Create: `tmp/repo-human-traceability/auth/task-1-report.md` (ignored evidence)
- Create: target semantic/navigation tests from Section 5 as failing tests
- Modify: this plan only for factual Task 1 evidence after approval

**Produces:** exact base tree/import inventory, five source-derived family traces, controlled
human sample, all 49 warning dispositions, public/persisted/security inventory, and PR cohort
assignment.

- [x] Verify planning approval, resulting-main/default-workflow evidence, clean non-default PR A
      branch `codex/rallar-auth-server-mutation-core`, and protected-plan hash.
- [x] Capture the exact 27-file source/blob/line/function/export/import inventory and all 49
      focused warning rows; map every row to owner, rationale, and PR.
- [x] Record the Section 2.3 human waiver on the same base without inferring observations.
- [x] Add RED semantic tests for seven command variants, credential secrecy, strict codecs,
      login, replay/no-op, security exits, operation ownership, compatibility, and navigation.
- [x] Record the explicit human sample waiver and approval of all 49 warning dispositions.
- [x] Obtain an independent Task 1 review with Critical 0 and Important 0.

### Task 2: Implement PR A Mutation And Login Core Test-First

**Status:** implemented, published, and merged through PR A. Task 2A protocol owners completed at
`56af2b93609ee5c71d670f97447fdc878a7317fc`, Task 2B credential/login owners at
`0acc1a28ec48913dd7b3db8e231f47adee05d4a6`, Task 2C facts/compute/service owners at
`4a8e286da93ff8aac733f8e032feadd5cccd0533`, and Task 2D validation owners at
`f321adeedd01fde22283087dea9e78669f6d9fdd`. Each cohort's final independent review
reported Critical 0 and Important 0. This Task 2E tree adds the first durable map and
stage-accurate supplementary evidence at exact commit
`b36f565c4cc7560eb0900a001c77f1000112077e`, tree
`3c9836a475b713c28668a11914475951aa6b0d40`; its independent review reported
Critical 0, Important 0, and Minor 0.

**Files:** target credential, login, mutation contract/codec/facts/compute/validate files;
initial README; directly owned mirrored tests; supported direct compatibility paths plus the
temporary PR A codec wrapper only as required.

**Interfaces:** preserve the seven `AuthMutationCommand` variants, `AuthMutationRead`,
`AuthMutationComputed`, `AuthMutationResult`, `AuthMutationPublicResult`,
`AuthMutationService`, `AuthCredentialIssuer`, `AuthUser`, and exact public exports.

- [x] Move contracts and strict command/result decoders with compile-time discriminant tests and
      runtime exact-field/property-order/error fixtures.
- [x] Move credential digest/issuer and login/registration decisions with exact algorithm,
      secrecy, static-client, invalid-credential, and public-surface tests.
- [x] Split facts, compute, and validation into real family owners; keep exhaustive routers under
      60 lines and preserve result/outbox object order.
- [x] Move only PR A tests and fixtures, preserve every assertion site, add lineage evidence, and
      ensure canonical PR A code bypasses compatibility modules.
- [x] Update the README's code-derived current/target traces and run the Task 2E focused gates.
- [x] Use fresh implementer and independent review cycles per cohesive cohort; resolve ordinary
      behavior-neutral findings test-first until Critical 0 and Important 0.

Section 11.2's complete unchanged-tree gate and whole-PR review were completed in Task 3.
PR B now owns the persistence/read/write/inbox target-path and re-export-only assertions.

### Task 3: Freeze, Review, And Publish PR A

- [x] Reconcile all 49 dispositions for PR A rows, focused checker output, compatibility imports,
      primary symbols, module/function limits, cycles, lost assertions, and security behavior.
- [x] Run Section 11.2 and repository completion gates on the final unchanged tree.
- [x] Freeze exact commit/tree, push non-forced, update one draft PR A, require Branch Release
      Gate, mark ready, and stop for human merge.
- [x] After merge, require exact resulting-main/default-workflow success before PR B.

The whole-PR review reported Critical 0, Important 1, and Minor 0. The sole Important finding was
an unmapped 116-column canonical decoder import in a shared-test consumer. Exact commit
`7ba002c222fc6c02e3d5bcfa9971b4ae3f778c49`, tree
`9a50b99d937437a3cbcc2d3f2b34154be78cf3f2`, routes that public consumer through the intentional
shared-server package entry; its scoped re-review reported Critical 0, Important 0, and Minor 0.
Branch Release Gate run `31155900583` attempt 1 failed only at changed repository style with 16
rows: thirteen untrusted/nested decode-boundary rows, two target filename mismatches, and the
transitional `auth-state-read.ts` filename mismatch. A separately authorized reconciliation uses
one exact-base structural-lineage manifest only for source-derived `boundary.unknown` capacity:
15 occurrences from base `services/auth-state-codecs.ts` map to nine command-decoder and six
result-decoder occurrences, while the credential issuer maps one base occurrence to one target
occurrence. New post-narrowing helpers use the named `AuthMutationRecord` return contract and
receive no additional capacity; every other rule retains zero inherited capacity.

The same correction renames the two private owners to `to-auth-logout-outbox.ts` and
`require-issue-session-lifecycle.ts`, restores the predecessor `captureAuthMutationFacts` runtime
identity binding from the still-executable `services/auth-state-read.ts`, and keeps
`services/auth-state-codecs.ts` as a direct re-export only. The temporary codec wrapper and PR A
manifest are owned by this child and are removed in the first later auth PR whose merge base no
longer needs the lineage, after an active-consumer scan proves no supported consumer remains.

Repository governance also exposed a completed client-state exact-base assertion whose recorded
removal condition was satisfied by ledger PR #75. A separate human authorization allowed removal
of only that obsolete subprocess assertion and its `spawnSync` import. Independent review reported
Critical 0, Important 0, and Minor 0; the retained client-state provenance suite passes 4 tests and
the complete repository-governance suite passes 278 tests.

PR A froze at feature `5118891effa1b9c856154ecab051c2df1b094145`, tree
`0082575cf0697a170c2125cf856ae07fedfe37e2`; Branch Release Gate `31159741601`
attempt 1 succeeded. PR #78 merged at `2026-08-07T08:53:42Z` as resulting main
`a90042398448776b0972aaaaa0f5cca762163fde`, tree
`9a3084c2c78f90f004054924b99b97be67fe72bd`, and Run Hetzner Supported Distributed
Manifests `31163606362` attempt 1 succeeded for that exact main SHA. Deploy Web + API run
`31163606018` separately failed its Cloudflare main-only branch-control job; this record does
not convert that failure into predecessor-gate success.

### Task 4: Implement PR B Authoritative Shell And Persistence Test-First

**Branch:** `codex/rallar-auth-server-authoritative-shell` from PR A's exact verified main
`a90042398448776b0972aaaaa0f5cca762163fde`.

**Status:** persistence owners are published in draft PR #81 through commits
`9008e55a32b8b8ecbe7c57a9a8dbf3506a4f72e3` and
`f163c697e7ffb1a35f6db11d802b4a866b02c3e1`, tree
`7ddee320f526e72a4b2cc3eca34d1b73ca355e32`. The remaining read/write/inbox cohort is
implemented locally and awaits its scoped review and publication update.

The cohort uses the Section 1.4 private refinement authority to keep the auth topic constant
with the pure routing owner, avoiding a service/handler import cycle; to name the shared
canonical/legacy session-read order in `read-auth-session-entries.ts`; and to split transaction
writes into the visible mutation, session/logout, and ticket-family owners already listed in the
target tree. One combined registration-and-routing semantic suite keeps construction silence,
later callback invocation, queue identity, and the full handler phase order together. The exact-
base shell lineage manifest maps the old AppAuth owner only to its new service and handler so the
two retained untrusted-boundary warnings inherit exactly the old two-occurrence capacity.

**Files:** target persistence/read/write/public-result/service/inbox files; package export and
exact import-only consumers; directly owned security, concurrency, PostgreSQL, and compatibility
tests.

- [x] Move strict persisted contracts, namespaces/keys, session/user/ticket repositories, expiry
      behavior, and bounded legacy readers behind canonical owners.
- [x] Move read and write families; prove canonical-before-legacy order, exact corruption exits,
      compare-and-set revisions, two-index session atomicity, single-use ticket consume, and
      logout outbox behavior.
- [x] Extract `AuthInboxHandler` and keep `AppAuthInboxService` as visible public registration and
      enqueue/completion owner with its existing constructor/method signatures.
- [x] Pass named complete dependencies at construction; preserve callback registration and later
      invocation, transaction/retry, durable result, terminal failure, and public reconstruction.
- [x] Update canonical package exports and only the import paths explicitly allowed by Section 7;
      leave out-of-scope policies and organization unchanged.
- [ ] Run independent scoped reviews after persistence and inbox cohorts; resolve in-scope
      behavior-neutral findings test-first.

### Task 5: Freeze, Measure, Review, And Publish PR B

Draft PR #81 is open at the published persistence head `f163c697e7ffb1a35f6db11d802b4a866b02c3e1`.
At `2026-08-07T11:16:21Z`, interim Branch Release Gate `31171930744` attempt 1 was still in
progress for that exact head, while CodeQL run `31171943558` had succeeded. This interim run is
not Task 5's final immutable-candidate gate; any later commit invalidates it as final evidence.

- [ ] Run all PR B focused security, transaction, concurrency, API, black-box, type, style,
      compatibility, and completion gates before candidate freeze.
- [ ] Obtain whole-PR Critical 0 and Important 0 review and human dispositions for every final
      focused warning.
- [ ] Create one immutable candidate and run exactly the Section 10 A-B-B-A protocol with no
      rerolls or content changes.
- [ ] If accepted, push the measured candidate, update the draft PR with immutable artifacts,
      require Branch Release Gate, mark ready, and stop for human merge.
- [ ] After merge, require exact resulting-main/default-workflow success before PR C.

### Task 6: Implement PR C Alignment And Final Traceability Test-First

**Branch:** `codex/rallar-auth-server-alignment` from PR B's exact verified main.

- [ ] Add the temporary auth source/style ratchet first, owned by this child with its later ledger
      as the removal/replacement decision point.
- [ ] Align only new/materially rewritten auth implementation, mirrored tests, navigation,
      evidence, ratchets, and compatibility files.
- [ ] Finish behavior-named test moves, imports/file ordering, named inputs/interfaces,
      100-column guidance, 60-line functions, 400-line modules, and primary-symbol matching.
- [ ] Prove each compatibility file is direct re-export-only, canonical auth callers bypass it,
      and every retained consumer/removal condition remains exact.
- [ ] Finalize all five family traces and repeat the controlled human sample without claiming
      statistical significance.
- [ ] Decide every supplementary ratchet as remove, semantic replacement, or retained with an
      owner/reason and ledger-time decision.

### Task 7: Freeze, Review, And Publish PR C

- [ ] Run Section 11.4 and every repository completion gate on the final unchanged tree.
- [ ] Reconfirm the mutation/concurrency classification and Section 10.3 performance
      applicability before candidate freeze.
- [ ] Require independent whole-child review with Critical 0 and Important 0 plus exact human
      review of warnings, navigation traces/sample, compatibility, and security behavior.
- [ ] Freeze exact commit/tree, push non-forced, update draft PR C, require Branch Release Gate,
      mark ready, and stop for human merge.
- [ ] After merge, verify exact resulting-main/default-workflow evidence externally.

### Task 8: Publish The Later Evidence Ledger Separately

- [ ] After PR C's exact main workflow succeeds, obtain separate human authorization for an
      evidence-only ledger branch.
- [ ] Modify only this child, master program, and execution plan to record already-existing
      planning/PR A/PR B/PR C envelopes, final warning dispositions, sample evidence, ratchet
      decisions, and accepted/rejected performance history.
- [ ] Preserve the non-circular contract: ledger tree/commit/PR/release/merge/default-workflow
      facts remain external until they exist.
- [ ] Publish and merge the ledger only after its own gates and human decision; mark auth
      `ledger-published` externally only after its exact default workflow succeeds.

## 10. Fixed Correctness, Security, And Performance Protocol

### 10.1 Classification

PR A moves pure protocol/login/credential/compute/validation decisions and does not change an
I/O, transaction, retry, or concurrency boundary. Exact semantic/security equivalence, source
lineage, type checks, and completion gates are sufficient only while that classification holds.

PR B structurally crosses the mutation path and concurrency domain by moving stable reads,
session/ticket persistence, conditional writes, AppInbox runtime dispatch, transaction entry,
durable completion, and authorization repositories. It requires the governed comparison below.

PR C is exempt only if every production/runtime and benchmark-harness blob is byte-identical to
PR B's exact resulting-main tree. Otherwise it requires the pre-authorized Section 10.3 sequence.

### 10.2 Security and correctness acceptance

Each PR must preserve and test:

- all seven command variants, queue identity, strict codec fields/order, and unsupported input;
- PBKDF2/HMAC/digest algorithms and exact plaintext non-persistence;
- registered/static login, disabled user, invalid credential, registration collision, and error
  timing/wording;
- session/ticket issue, proof, expiry, logout, one-use consume, replay, no-op, legacy cutoff,
  bounded scan, corruption, and digest mismatch exits;
- current read/compute/validate/write order, retry re-entry, exact attempts/backoff/fairness,
  conditional revisions, transaction atomicity, durable result, logout outbox, terminal failure,
  and caller result;
- API bearer/WS proof, admin, CRDT, group, client, topology, room/topic, and black-box behavior;
  and
- no secret, token, password, credential, or authorization header in logs, reports, benchmark
  artifacts, PR evidence, or handoffs.

Any security fixture or artifact uses deterministic digests/redacted identities only. A test may
hold a secret in process when required by production behavior but must not print or persist it.

### 10.3 Governed PR B comparison fixed before candidate freeze

Use exactly one non-rerolled order-balanced A-B-B-A sequence:

1. PR A's exact resulting-main SHA;
2. exact final PR B candidate;
3. the same exact PR B candidate;
4. the same exact PR A resulting-main SHA.

Use the existing pinned PostgreSQL 16 image and normalized isolated-host protocol: fresh
non-overlapping container per position, identical configuration/resource limits,
autovacuum/analyze disabled, zero preflight rows, zero automatic maintenance, no other active
benchmark/container/Deno-LSP process, `warmup=1`, `runs=9`, and `concurrency=10`. Each position
runs once. A guard failure before any warmup/sample/artifact is rejected evidence and requires
explicit human authorization before replacement; a consumed measurement is never rerolled.

Run the established `npm run perf:api-v1:state-write` harness. It directly measures the
production AuthSessionRepository authorization reads used by the client/group/topology mutation
mix while retaining exact AppInbox retries, receipts, outbox, and SQL evidence. It does not
measure password hashing or credential issuance; those unchanged algorithms are protected by
source lineage and security tests, and no claim is made about their runtime.

Pool exactly 18 raw samples per workload per side with the existing fail-closed pooler. Preserve
all source artifacts, environment records, logs, manifests, hashes, and raw samples. Run the
unchanged global comparator and retain its exact exit/output, then the unchanged 1.5% child
evaluator. Preserve the existing contract:

- uncontended p95/p99 adverse latency at most 5%;
- shared throughput adverse movement at most 1.5%;
- hot throughput adverse movement at most 10%;
- SQL statements, rows read, serialized bytes, and transaction duration adverse movement at
  most 1.5%, unless existing artifact-backed conflict-depth evidence accepts the movement;
- unrestricted improvements and fail-closed zero baselines; and
- zero tolerance for commands, receipts, effects, retries, exhaustion, atomic completion,
  idempotency, ordering, audience, required/final outbox, schema, environment, and artifact
  correctness.

Unknown findings, changed hashes, missing samples, incompatible environments, unsupported
metrics, malformed artifacts, or missing conflict evidence fail closed. No result authorizes an
optimization, threshold change, reroll, or different candidate.

### 10.4 PR C exact-runtime applicability

Before PR C freezes, compare every production/runtime and benchmark-harness blob with PR B's
exact resulting-main tree. If byte-identical, record the exact comparison and retain PR B's
result. If any differs, run one new non-rerolled A-B-B-A under Section 10.3 using PR B's exact
resulting-main as A1/A2 and exact PR C candidate as B1/B2. Any change to the harness, environment,
comparator, evaluator, threshold, or classification stops for human review.

## 11. Validation Matrix

### 11.1 Planning PR

```bash
npx prettier --check plans/rallar-auth-server-structure-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md \
  plans/rallar-client-state-server-structure-plan.md
git diff --check
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

### 11.2 PR A mutation/login gates

```bash
npx vitest run packages/tests/shared-server/auth
npx vitest run packages/tests/shared/authoritative-state-contracts.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx vitest run packages/tests/repo/auth-server-lineage-provenance.test.ts \
  packages/tests/repo/auth-server-navigation-map-integrity.test.ts \
  packages/tests/repo/auth-server-ownership.test.ts \
  packages/tests/repo/auth-server-test-ownership.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

### 11.3 PR B authoritative shell, security, and concurrency gates

```bash
npx vitest run packages/tests/shared-server/auth
npx vitest run packages/tests/shared-server/app-inbox-service.test.ts \
  packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  "--allow-run=$(deno eval 'console.log(Deno.execPath())')" \
  test/config-route-auth-logout.test.ts \
  test/request-admin-auth-service.test.ts \
  test/request-auth-service.test.ts \
  test/routes/agent-session-ticket-route.test.ts \
  test/services/ws-topic-room-authorizer.test.ts \
  test/db/pglite-auth-app-inbox.test.ts \
  test/db/pglite-auth-failure-atomicity.test.ts \
  test/db/pglite-auth-transaction-rollback.test.ts \
  test/db/pglite-crdt-ws-authority-correction-4.test.ts
cd ../..
npx vitest run packages/tests/rallar-black-box/auth-flow.test.ts \
  packages/tests/rallar-black-box/auth-lifecycle.test.ts
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

Run the Section 10.3 sequence only after every content/review gate passes and the candidate is
immutable.

### 11.4 PR C and final child gates

```bash
npm run test:repo-governance
npx vitest run packages/tests/shared-server/auth
npx vitest run packages/tests/rallar-black-box/auth-flow.test.ts \
  packages/tests/rallar-black-box/auth-lifecycle.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check && cd ../..
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run check:repo-style
npm run check:repo-style:construction-details
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
node scripts/check-changed-repo-style.mjs --base <exact-predecessor-resulting-main>
npx prettier --check packages/shared-server/rallar-system/auth \
  packages/tests/shared-server/auth packages/tests/repo/auth-server-* \
  plans/rallar-auth-server-structure-plan.md
git diff --check
test "$(find packages/shared-server/rallar-system/auth -name '*.ts' -type f -print0 \
  | xargs -0 wc -l | awk '$2 != "total" && $1 > 400 { print }' | wc -l | tr -d ' ')" = "0"
npm run test:unit
npm run test:ci
npm run build
```

`<exact-predecessor-resulting-main>` is supplied from the verified external merge envelope for
each PR and is never guessed or recorded before it exists.

## 12. Human Review And Publication Gates

Human decisions are required at these exact points:

1. approve or revise this exact plan blob;
2. approve Task 1's controlled navigation sample and all 49 warning dispositions;
3. approve merging exact PR A after its Branch Release Gate;
4. approve merging exact PR B after its immutable performance/review/gate evidence;
5. approve PR C compatibility/ratchet decisions and exact merge;
6. separately authorize the later evidence-ledger publication; and
7. approve and close that ledger before another Wave 2 child begins.

Ordinary behavior-neutral private refinements and review fixes within Section 1.4 proceed
autonomously. Each PR remains draft until focused and completion gates, independent review
Critical 0/Important 0, exact tree freeze, current PR evidence, and Branch Release Gate all pass.

No agent merges a PR or operates on the default branch. Resulting-main workflows are verified
after the human merge and before the next PR.

## 13. Non-Circular Completion Evidence

This planning tree records only existing prerequisite/base facts. It cannot contain its own
future tree, commit, PR, Branch Release Gate, merge SHA, or default workflow.

Each implementation PR may record completed local tasks and already-existing predecessor
publication facts. Its future merge, resulting-main SHA, and default workflow remain in the PR
and Mandatory Completion Handoff external envelope. The next PR may reconcile them only after
they exist.

The later ledger records completed planning/PR A/PR B/PR C envelopes, but not its own future
tree, commit, PR, Branch Release Gate, merge, or default workflow. Only after that external
envelope succeeds may auth be marked `ledger-published`.

Any content change after validation, review, or candidate freeze invalidates the affected
evidence. Historical failures and measurements remain historical and are never relabeled for a
changed tree.

## 14. Acceptance Checklist

- [x] Human approved this exact auth child plan Git blob.
- [x] Planning PR merged and its exact resulting-main workflow succeeded.
- [x] Controlled before/after human samples were honestly recorded or separately waived.
- [x] Every focused warning row received explicit human owner/rationale disposition.
- [ ] Three implementation PRs remained independently reviewable.
- [ ] Every target filename matches its primary symbol and every owner is cohesive/direct.
- [ ] Canonical auth callers bypass compatibility-only wrappers.
- [ ] Every supported export/path remains direct one-hop compatible.
- [ ] Every public/persisted/security/credential/session/ticket/legacy contract is exact.
- [ ] AppInbox, transaction, retry, durable result, receipt, logout outbox, and completion are
      exact.
- [ ] Semantic security/ownership/exit tests remain primary and all ratchets have decisions.
- [x] PR A review/gates and exact resulting-main workflow succeeded.
- [ ] PR B review/gates, governed performance, and exact resulting-main workflow succeeded.
- [ ] PR C review/gates and exact resulting-main workflow succeeded.
- [ ] The separate evidence ledger independently reached `ledger-published`.
- [ ] API-v1 organization and all later Wave 2 domains remained unstarted.

## 15. Risks And Stop Conditions

| Risk                                                      | Required response                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Split adds forwarding or hides a security decision        | Repartition by real protocol/decision/persistence owner; do not satisfy limits mechanically. |
| Credential/password/digest behavior changes               | Restore exact behavior test-first or stop for separate security approval.                    |
| Persisted field/key/legacy/expiry behavior changes        | Stop for explicit persisted/security contract approval.                                      |
| AppInbox transaction/retry/result/outbox becomes indirect | Restore exact named owner and trace; stop for semantic redesign.                             |
| Authorization policy moves into auth                      | Keep policy in its current domain; only canonical proof/repository imports may move.         |
| Public/deep import needs a second hop                     | Keep one direct old-to-canonical export and return the exact consumer for review.            |
| API-v1 organization or route behavior appears necessary   | Stop; characterize or update an approved import path only.                                   |
| Warning is ignored because checker exits zero             | Stop until human disposition exists.                                                         |
| Ratchet replaces semantic evidence                        | Restore semantic tests; keep ratchet supplementary with owner/removal decision.              |
| Performance/environment/protocol changes after freeze     | Stop; no reroll, threshold change, or evidence relabeling.                                   |
| Protected unrelated plan changes                          | Restore it before publication.                                                               |
| Required external gate persistently fails                 | Stop with exact run/job/step; do not diagnose unrelated providers.                           |

## 16. Progress Record

| Milestone                  | State            | Evidence                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client-state prerequisite  | ledger-published | PR #75 feature `2858bf0c2a9b882a82ae4c33abf58d6e0408be8d`, tree `104478f66bcabbbcf101ea97a80d2a2060cb10ec`, Branch Release Gate `31097790516` attempt 2, resulting main `6b75cfc5ec61f81b465be9072b746d24ecdb5f22`, default workflow `31100952224` attempt 1 success.                                                          |
| Auth child plan            | approved         | Exact blob `123990bceac9732660e1113101addd5b194d8347`; PR #76 feature `38a961c4ee184856422b3acf6f0494d04d8d6e5b`; Branch Release Gate `31103489838` attempt 2 success; resulting main `61e708708f94328f095f1f1fa5690747bb933476`; default workflow `31106485616` attempt 1 success.                                            |
| PR A mutation/login core   | merged           | PR #78 feature `5118891effa1b9c856154ecab051c2df1b094145`, tree `0082575cf0697a170c2125cf856ae07fedfe37e2`; Branch Release Gate `31159741601` attempt 1 success; resulting main `a90042398448776b0972aaaaa0f5cca762163fde`, tree `9a3084c2c78f90f004054924b99b97be67fe72bd`; Hetzner workflow `31163606362` attempt 1 success. |
| PR B authoritative shell   | in progress      | Draft PR #81 publishes persistence commits through `f163c697e7ffb1a35f6db11d802b4a866b02c3e1`, tree `7ddee320f526e72a4b2cc3eca34d1b73ca355e32`; read/write/inbox implementation is local pending scoped review and Task 5 candidate gates.                                                                                     |
| PR C alignment/final trace | blocked          | Waits for PR B exact merge/default workflow.                                                                                                                                                                                                                                                                                   |
| Later auth ledger          | blocked          | Requires completed PR C merge/default workflow and separate human authorization.                                                                                                                                                                                                                                               |
| Later Wave 2 domains       | blocked          | Topology, RTC/RTT, CRDT, and admin do not begin here.                                                                                                                                                                                                                                                                          |

## 17. Planning Self-Review Record

Before publishing the planning PR, review the complete plan for:

- missing auth production, consumer, public, compatibility, test, security, or black-box owner;
- placeholders other than future external facts that cannot yet exist;
- inconsistent filename, primary symbol, command kind, response, namespace, or key names;
- generic ownership, pass-through files, mutable dependencies, cycles, hidden defaults,
  duplicated validation, extra compatibility hops, or transaction callbacks whose semantics are
  not visible;
- construction/registration confused with later queue invocation;
- incomplete login, registration, mutation, session, ticket, logout, expiry, legacy,
  authentication, authorization, retry, early-exit, failure, cleanup, or public-result trace;
- hidden API-v1, client/group/topology/CRDT/admin, public/persisted, credential, authority,
  AppInbox, transaction, retry, timing, checker, dependency, workflow, or performance change;
- review cohorts likely to exceed the stated thresholds;
- source ratchets without an owner and ledger-time removal/replacement decision;
- warning output without explicit human disposition;
- a performance claim about an unmeasured credential path; and
- any future publication evidence or production behavior lacking explicit human approval.

Any unresolved Critical or Important finding returns the exact plan blob to revision before
approval. The self-review may correct planning facts and names; it may not implement or
pre-approve a semantic change.
