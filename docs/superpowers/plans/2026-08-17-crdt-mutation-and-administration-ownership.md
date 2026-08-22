# CRDT Mutation And Administration Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete server-side CRDT mutation and administration path directly navigable
under one shared-server feature owner while preserving every public, protocol, persistence,
transaction, retry, and API contract and fixing the default audit-delivery registration and final
outbox collision bugs.

**Architecture:** Consolidate shared-server CRDT realtime, inbox, mutation, and persistence owners
under `packages/shared-server/rallar-system/crdt/`. Keep API session translation, CRDT HTTP routes,
admin request/result mapping, and runtime construction under `apps/api-v1/src/crdt/`. Deliver the
work as two stacked pull requests: Slice 1 establishes the shared core and the minimum API bridge
needed to remove API policy from the shared inbox; Slice 2 completes API-v1 administration,
consumer, test, and navigation alignment.

**Tech Stack:** TypeScript 7 with `erasableSyntaxOnly`, Vitest, Deno 2, Hono, PostgreSQL/PGlite,
ResourceInbox/AppInbox/QueueBox, Prettier, repository style and structure checkers, API-v1 black-box
recipes, and the API-v1 state-write comparison harness.

## Global Constraints

- The approved design is
  `docs/superpowers/specs/2026-08-17-crdt-mutation-and-administration-ownership-design.md`.
- Planning base is exact `origin/main`
  `22bb4919c92f96d785ff65d7f308a6d2fd3318e7`.
- The intended outcome is a behavior-preserving ownership refactor. The two already-classified
  behavior corrections are missing-audit-sink registration and accepting an identical existing
  final outbox row instead of rolling back on every collision.
- Preserve the actual package-root CRDT runtime surface: `installRallarCrdtWsTopics`,
  `validateRallarCrdtServerLiveEnvelope`, both `RALLAR_CRDT_SERVER_DEFAULT_*` constants, every
  currently exported `RallarCrdtServer*` type, `InMemoryRallarCrdtLogRepository`,
  `PSqlCrdtLogRepository`, and both repository options type names. All supported consumers are in
  this repository, so their compile-time contracts migrate with the implementation. There is no
  exported `RallarCrdtServer` class or value.
- Preserve REST paths, HTTP status and JSON shapes, OpenAPI contracts, WebSocket topics and payloads,
  AppInbox types and keys, command/result versions, persisted rows, document keys, policy defaults,
  optimistic guards, retry ownership, final outbox identities, and observable dependency ordering.
- AppInbox owns transaction and retry. The mutation service retains a visible
  `read -> compute -> validate -> write(transaction, computed)` attempt and never opens or retries a
  transaction.
- Final outbox inserts remain in the authoritative transaction. An outbox collision rolls back; it
  never reads or returns a winner.
- Keep `unknown` at JSON, framework, environment, queue, or caught-error boundaries and normalize it
  before domain logic.
- Use one canonical type name. Do not introduce rename aliases, import renames, runtime namespaces,
  enums, double assertions, test-only production exports, hidden defaults, service locators, setter
  injection, or forward-captured callbacks.
- Functions accept at most three positional parameters. Task 5 migrates every in-repository
  `validateRallarCrdtServerLiveEnvelope` consumer to one
  `ValidateRallarCrdtServerLiveEnvelopeInput`; no positional adapter or retained-legacy entry
  remains. The public symbol name and package-root runtime identity stay stable.
  Classes in `packages/**` use an adjacent type-only same-name namespace when several contracts
  belong to the class. Deno-owned API code keeps flat feature-prefixed contracts.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- Remove affected legacy and vacated old paths when no verified consumer requires them. A retained
  public, persisted, protocol, or migration compatibility boundary requires explicit maintainer
  approval and the repository's focused registry entry.
- Fix actual affected bugs with a failing semantic test. For another confirmed code or performance
  weakness that cannot be closed without expanding the active slice, search open issues and create
  or reuse one accurate issue before handoff.
- Tests are behavior-named and semantic. Exact-tree, source-text, line-count, and task-history tests
  are replaced when direct behavior or architecture tests own the same risk.
- Generated performance artifacts stay under `tmp/perf/` and are not committed.
- Issue [#265](https://github.com/intact-software-systems/ar-eye-hunter/issues/265) owns the confirmed
  PostgreSQL append full-history read/decode weakness. This ownership refactor preserves that query
  boundary and makes no CRDT-specific performance claim unless representative measurements activate
  a separately reviewed optimization.
- Run focused behavior tests before package, application, live database, black-box, performance, and
  repository-wide checks. Report every required check as passed, failed, or skipped.

### Task 3 consumer ruling

`@ar-eye-hunter/shared-server` is private and every supported consumer is in this repository.
Internally controlled types and tests do not establish an external compatibility dependency. Task
3 therefore migrates all repository consumers atomically, introduces a named read/administration
contract, removes the six fail-closed PostgreSQL mutation methods and their rejection helper,
removes the open options index and unused option fields, and creates no retained-legacy registry
entry for those deleted shapes. The package-root `PSqlCrdtLogRepository` name and runtime identity
remain stable. The final-outbox collision correction and all persisted/protocol contracts remain
unchanged.

---

## Delivery Stack And Working Horizon

Only these two slices are concrete:

1. **Slice 1 / PR A — core mutation ownership.** Contracts, exact codecs, pure computation,
   validation, transaction shell, persistence, inbox, audit delivery, WebSocket ingress, realtime
   protocol, in-memory repository, package exports, direct tests, and the minimum API admin bridge
   required to remove API policy from the shared inbox.
2. **Slice 2 / PR B — administration and consumer alignment.** API CRDT authorization,
   construction, routes, general admin-gateway consumption, mirrored tests, active navigation,
   cold trace, full live validation, and final legacy closure.

Use the current `codex/crdt-ownership-design` branch for PR A. Fork
`codex/crdt-api-alignment` from the accepted PR A head for PR B. Do not merge PR B before PR A.

## Final Ownership Map

The target tree is exact at the capability level. Small exact codecs may remain separate when they
authenticate a wire or persisted boundary; one-use wrappers and mechanical splits do not remain.

```text
packages/shared-server/rallar-system/crdt/
  README.md
  realtime/
    rallar-crdt-server-contracts.ts
    install-rallar-crdt-ws-topics.ts
    validate-rallar-crdt-server-live-envelope.ts
    validate-rallar-crdt-catch-up-envelope.ts
  inbox/
    app-crdt-inbox-service.ts
    create-authenticated-crdt-append.ts
    create-crdt-ws-mutation-ingress.ts
    register-crdt-audit-delivery.ts
  mutation/
    crdt-mutation-contracts.ts
    crdt-mutation-command-codec.ts
    decode-crdt-mutation-result.ts
    crdt-mutation-value-codec.ts
    crdt-mutation-result-detail-codec.ts
    crdt-operation-exact-codec.ts
    crdt-snapshot-state-exact-codec.ts
    decode-exact-update-envelope.ts
    decode-exact-debug-bundle.ts
    crdt-append-rejection.ts
    to-crdt-canonical-snapshot.ts
    create-crdt-mutation-result.ts
    compute-crdt-mutation-outcome.ts
    compute-crdt-mutation.ts
    validate-crdt-mutation.ts
    create-crdt-mutation-outbox.ts
    create-crdt-mutation-service.ts
  persistence/
    in-memory-crdt-document-store.ts
    compute-in-memory-crdt-append.ts
    in-memory-crdt-append.ts
    in-memory-crdt-administration.ts
    in-memory-crdt-log-repository.ts
    psql-crdt-log-repository.ts
    psql-crdt-mutation-repository.ts
    crdt-mutation-row-codec.ts

apps/api-v1/src/crdt/
  create-api-crdt-document-authorizer.ts
  create-api-crdt-inbox-service.ts
  create-api-crdt-inbox-factory.ts
  create-crdt-admin-mutations.ts
  register-crdt-admin-routes.ts
```

There is no nested `mod.ts`. Internal callers import direct owners. The existing
`packages/shared-server/mod.ts` package boundary re-exports only the previously public CRDT names
from their canonical owners.

## Canonical Interfaces

These names and shapes are shared between tasks. Do not invent neighboring aliases.

```ts
export interface CrdtMutationAttemptFacts {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
}

export interface ValidateCrdtMutationInput {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly computed: CrdtMutationComputed;
}

export interface CrdtMutationValidationIssue {
    readonly code: string;
    readonly message: string;
}

export interface CreateAndEnqueueCrdtAppendInput {
    readonly update: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly actor: CrdtMutationActor;
    readonly responseAudience: CrdtMutationResponseAudience;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export interface CurrentCrdtMutationSession {
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
}

export type ReadCurrentCrdtMutationSession = (
    input: Readonly<{ sessionId: string; atEpochMs: number; }>
) => Promise<CurrentCrdtMutationSession>;

export interface CrdtMutationService {
    read(command: CrdtMutationCommand): Promise<CrdtMutationRead>;
    compute(facts: CrdtMutationAttemptFacts): CrdtMutationComputed;
    validate(input: ValidateCrdtMutationInput): readonly CrdtMutationValidationIssue[];
    write(
        transaction: PSqlTransactionSql,
        computed: CrdtMutationComputed
    ): Promise<CrdtMutationResult>;
}

export namespace AppCrdtInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly outboxQueueReader: OutboxQueueReader;
        readonly resourceInboxRepository: ResourceInboxRepository;
        readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
        readonly database: PSqlSql;
        readonly mutationService: CrdtMutationService;
        readonly readCurrentSession: ReadCurrentCrdtMutationSession;
        readonly wakeQueueEngine: () => void;
        readonly auditDelivery?: Readonly<{
            outboxQueueReader: OutboxQueueReader;
            auditSink: RallarCrdtAuditSink;
        }>;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing: RallarTimingSink | undefined;
        readonly appInbox: AppInboxServiceOptions;
    }
}

export class AppCrdtInboxService extends AppInboxService {
    constructor(dependencies: AppCrdtInboxService.Dependencies, config: AppCrdtInboxService.Config);

    createAndEnqueueAppend(input: CreateAndEnqueueCrdtAppendInput): Promise<CrdtAppendCommand>;
    createAndEnqueueAuthenticatedAppend(
        input: AuthenticatedCrdtAppendInput
    ): Promise<CrdtAppendCommand>;
    writeCrdtCommandUntilCompletion(
        command: CrdtMutationCommand
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>>;
    writeCrdtCommandNoWaiting(command: CrdtMutationCommand): void;
}

export type CrdtAdminMutationOperation = 'rebuild-projection' | 'compact' | 'lifecycle' | 'erase';

export interface CrdtAdminMutationInput {
    readonly operation: CrdtAdminMutationOperation;
    readonly adminSession: AuthSession;
    readonly request: unknown;
}

export interface CrdtAdminMutations {
    writeCrdtAdminMutation(input: CrdtAdminMutationInput): Promise<unknown>;
}
```

`CrdtAdminMutationInput.request` is the untrusted HTTP boundary. The API owner decodes it once
into a complete `CrdtMutationCommand`; `unknown` never reaches shared mutation computation.
`CrdtMutationComputed` gains required `command` and `read` references. They are attempt-local
provenance, are not serialized, and let validation authenticate the exact facts used by compute.

## Test Migration Map

Move tests by behavior while retaining every existing semantic assertion:

| Current test                                                                            | Final behavior-named test                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tests/shared-server/app-crdt-inbox-service.test.ts`                           | `packages/tests/shared-server/crdt/mutation/crdt-mutation-service.test.ts` and `packages/tests/shared-server/crdt/inbox/app-crdt-inbox-service.test.ts`                                                                            |
| `packages/tests/shared-server/crdt-app-inbox-ingress-correction.test.ts`                | `packages/tests/shared-server/crdt/inbox/crdt-app-inbox-ingress.test.ts`                                                                                                                                                           |
| `packages/tests/shared-server/crdt-mutation-correction-2.test.ts`                       | `packages/tests/shared-server/crdt/mutation/crdt-mutation-safety-invariants.test.ts`                                                                                                                                               |
| `packages/tests/shared-server/crdt-mutation-correction-3.test.ts`                       | `packages/tests/shared-server/crdt/mutation/crdt-persisted-contract-invariants.test.ts`                                                                                                                                            |
| `packages/tests/shared-server/crdt-mutation-correction-4.test.ts`                       | `packages/tests/shared-server/crdt/mutation/crdt-append-result-invariants.test.ts`                                                                                                                                                 |
| `packages/tests/shared-server/crdt-mutation-exact-codec.test.ts`                        | `packages/tests/shared-server/crdt/mutation/crdt-exact-codecs.test.ts`                                                                                                                                                             |
| `packages/tests/shared-server/crdt-task9-correction.test.ts`                            | `packages/tests/shared-server/crdt/mutation/crdt-command-and-outbox-invariants.test.ts`                                                                                                                                            |
| `packages/tests/shared-server/rallar-crdt-log-repository.test.ts`                       | `packages/tests/shared-server/crdt/persistence/in-memory-crdt-log-repository.test.ts`                                                                                                                                              |
| `packages/tests/shared-server/rallar-crdt-server-topic.test.ts`                         | `packages/tests/shared-server/crdt/realtime/rallar-crdt-server.test.ts`                                                                                                                                                            |
| `packages/tests/shared-server/rallar-middleware-crdt-principal-correction-4.test.ts`    | `packages/tests/shared-server/crdt/realtime/crdt-principal-fanout-cold-cache.test.ts`                                                                                                                                              |
| `packages/tests/shared-server/admin-prune-correction-4.test.ts`                         | `packages/tests/shared-server/admin-prune-retry-lifetime.test.ts` plus `apps/api-v1/test/crdt/inbox/crdt-admin-command-expiry.test.ts`; replace its CRDT source-text assertion with command capture                                |
| `apps/api-v1/test/db/pglite-crdt-app-inbox-production-correction-2.test.ts`             | `apps/api-v1/test/crdt/inbox/crdt-production-inbox.test.ts`                                                                                                                                                                        |
| `apps/api-v1/test/db/pglite-crdt-app-inbox-transaction.test.ts`                         | `apps/api-v1/test/crdt/persistence/crdt-app-inbox-atomicity.test.ts`                                                                                                                                                               |
| CRDT cases in `apps/api-v1/test/db/pglite-crdt-correction-3.test.ts`                    | `apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts`, `apps/api-v1/test/crdt/persistence/crdt-legacy-snapshot-migration.test.ts`, and `apps/api-v1/test/crdt/persistence/crdt-app-inbox-conflict-retry.test.ts` |
| The two unrelated prune cases in `apps/api-v1/test/db/pglite-crdt-correction-3.test.ts` | `apps/api-v1/test/db/pglite-admin-prune-cutoff-and-expiry.test.ts`                                                                                                                                                                 |
| `apps/api-v1/test/db/pglite-crdt-policy-correction-4.test.ts`                           | `apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts`                                                                                                                                                            |
| `apps/api-v1/test/db/pglite-crdt-public-reads-correction-4.test.ts`                     | `apps/api-v1/test/crdt/persistence/crdt-public-read-integrity.test.ts`                                                                                                                                                             |
| `apps/api-v1/test/db/pglite-crdt-snapshot-reason-correction-6.test.ts`                  | `apps/api-v1/test/crdt/persistence/crdt-snapshot-reason.test.ts`                                                                                                                                                                   |
| `apps/api-v1/test/db/pglite-crdt-task9-correction.test.ts`                              | `apps/api-v1/test/crdt/persistence/crdt-persisted-contracts.test.ts`                                                                                                                                                               |
| `apps/api-v1/test/db/pglite-crdt-ws-authority-correction-4.test.ts`                     | `apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts`                                                                                                                                                                  |
| `apps/api-v1/test/routes/crdt-*.test.ts`                                                | `apps/api-v1/test/crdt/routes/*.test.ts`                                                                                                                                                                                           |

Do not combine unrelated scenarios merely to reduce file count. Shared fixtures move to
`packages/tests/shared-server/crdt/crdt-test-fixtures.ts` or
`apps/api-v1/test/crdt/crdt-api-test-fixtures.ts` only when at least two behavior suites share the
same domain setup.

---

## Slice 1 / PR A — Core Mutation Ownership

### Task 1: Freeze Baseline And Establish Mutation Contract Ownership

**Files:**

- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-operation-exact-codec.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-snapshot-state-exact-codec.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/decode-exact-update-envelope.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/decode-exact-debug-bundle.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-result-detail-codec.ts`
- Modify imports: `packages/shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts`
- Modify imports: `packages/shared-server/postgres/crdt/crdt-mutation-row-codec.ts`
- Modify imports: `apps/api-v1/src/services/create-api-crdt-document-authorizer.ts`
- Modify imports: `apps/api-v1/test/db/pglite-crdt-app-inbox-production-correction-2.test.ts`
- Modify imports: both API-v1 state-write command/result evidence owners
- Modify: `packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts`
- Move/Test: the four exact-contract suites listed in the migration map
- Remove after migration: the corresponding old `rallar-system/services/crdt-*codec.ts` files

**Interfaces:**

- Consumes: existing `AppInboxType`, shared CRDT envelopes, policies, snapshots, audit events, and
  operation batches.
- Produces: the canonical `CrdtMutationCommand`, `CrdtMutationRead`, `CrdtMutationComputed`,
  `CrdtMutationResult`, `CrdtMutationRepository`, command decoder/creator, and result decoder used by
  every later task.

- [ ] **Step 1: Record the exact production-free baseline**

Run before production edits:

```bash
git status --short
npx vitest run \
  packages/tests/shared-server/app-crdt-inbox-service.test.ts \
  packages/tests/shared-server/crdt-mutation-correction-2.test.ts \
  packages/tests/shared-server/crdt-mutation-correction-3.test.ts \
  packages/tests/shared-server/crdt-mutation-correction-4.test.ts \
  packages/tests/shared-server/crdt-mutation-exact-codec.test.ts \
  packages/tests/shared-server/crdt-task9-correction.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: all focused tests and shared-server typecheck pass. Record counts in the task report.

- [ ] **Step 2: Capture the general state-write baseline required by the mutation-path gate**

Against a freshly migrated Postgres database, run:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-baseline.json
```

Expected: exit 0 with a valid baseline artifact. This harness does not execute CRDT mutations and
must not be described as CRDT-specific performance evidence; it is the repository-mandated shared
mutation/concurrency regression gate.

- [ ] **Step 3: Move the behavior tests and verify RED on canonical imports**

Use `git mv` for history, then change imports to the target mutation paths:

```bash
mkdir -p packages/tests/shared-server/crdt/mutation
git mv packages/tests/shared-server/crdt-mutation-correction-2.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-mutation-safety-invariants.test.ts
git mv packages/tests/shared-server/crdt-mutation-correction-3.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-persisted-contract-invariants.test.ts
git mv packages/tests/shared-server/crdt-mutation-correction-4.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-append-result-invariants.test.ts
git mv packages/tests/shared-server/crdt-mutation-exact-codec.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-exact-codecs.test.ts
```

Run:

```bash
npx vitest run packages/tests/shared-server/crdt/mutation
```

Expected: FAIL because the canonical `rallar-system/crdt/mutation/**` modules do not exist.

- [ ] **Step 4: Move the contracts and exact codecs without changing runtime semantics**

Use these exact moves:

```bash
mkdir -p packages/shared-server/rallar-system/crdt/mutation
git mv packages/shared-server/rallar-system/services/crdt-mutation-contracts.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-result-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-value-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts
git mv packages/shared-server/rallar-system/services/crdt-operation-exact-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-operation-exact-codec.ts
git mv packages/shared-server/rallar-system/services/crdt-snapshot-state-exact-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-snapshot-state-exact-codec.ts
git mv packages/shared-server/rallar-system/services/crdt-update-exact-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/decode-exact-update-envelope.ts
git mv packages/shared-server/rallar-system/services/crdt-debug-bundle-exact-codec.ts \
  packages/shared-server/rallar-system/crdt/mutation/decode-exact-debug-bundle.ts
```

Update direct imports. Remove the command codec's re-export barrel behavior; callers import
`crdt-mutation-contracts.ts` and `decode-crdt-mutation-result.ts` directly.

- [ ] **Step 5: Close the moved files to current type and boundary standards**

Keep the existing discriminated unions. Convert plain object `type` declarations to interfaces only
when they are concrete object contracts; keep unions as types. Replace propagated records returned
from exact decoders with canonical domain values after complete runtime validation. Do not add a
local alias for any shared CRDT type.

Keep `createCrdtMutationCommand` and `decodeCrdtMutationCommand` as the two canonical command
boundaries. The creator canonicalizes compact snapshot reason, fills `deliveryId`, derives
`documentKey`, fixes version 1, hashes the complete stable command, and passes the result through
the decoder. The decoder retains the current order: exact record and operation keys, version,
identity, epochs, actor, audience, document, operation fields, document key, then canonical hash.
Invalid shapes and relationships continue to throw the current `TypeError` messages.

Move the current audit-event decoder out of `AppCrdtInboxService` into
`crdt-mutation-value-codec.ts` as `decodeCrdtAuditEvent`. It validates the exact six keys, event
kind, epoch, non-empty identities/reason, and record metadata before one boundary assertion. Remove
the current double assertion; malformed content keeps the existing
`CRDT audit outbox event is invalid` error.

- [ ] **Step 6: Run GREEN and focused closure**

```bash
npx vitest run packages/tests/shared-server/crdt/mutation
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
cd ../..
npm --workspace @ar-eye-hunter/shared-test run check
npx prettier --check \
  packages/shared-server/rallar-system/crdt/mutation \
  packages/tests/shared-server/crdt/mutation
git diff --check
```

Expected: all moved contract tests, typecheck, formatting, and diff checks pass.

- [ ] **Step 7: Commit the contract boundary**

```bash
git add packages/shared-server/rallar-system/crdt/mutation \
  packages/shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts \
  packages/shared-server/postgres/crdt/crdt-mutation-row-codec.ts \
  packages/tests/shared-server/crdt/mutation \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  apps/api-v1/src/services/create-api-crdt-document-authorizer.ts \
  apps/api-v1/test/db/pglite-crdt-app-inbox-production-correction-2.test.ts \
  packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-command-codecs.ts \
  packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-result-evidence.ts
git commit -m "refactor(crdt): establish canonical mutation contracts"
```

### Task 2: Move Pure Mutation Decisions And The Transaction Shell

**Task 2 fix-round ruling:** the direct mutation suite and the six listed historical correction
paths were moved early to their final behavior-named destinations. Task 2 also removes the mutable
audit setter and its default-server cleanup call; later tasks must consume those owners and must not
repeat either move or setter removal.

**Files:**

- Create: `packages/shared-server/rallar-system/crdt/mutation/compute-crdt-mutation.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/validate-crdt-mutation.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-result.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/compute-crdt-mutation-outcome.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-outbox.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/crdt-append-rejection.ts`
- Create: `packages/shared-server/rallar-system/crdt/mutation/to-crdt-canonical-snapshot.ts`
- Modify imports: `packages/shared-server/rallar-system/services/AppCrdtInboxService.ts`
- Modify imports: `packages/tests/shared-server/crdt-app-inbox-ingress-correction.test.ts`
- Modify imports: `apps/api-v1/src/services/create-api-crdt-inbox-service.ts`
- Modify imports: `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`
- Modify imports: the current production, transaction, correction-3 fixture, public-read,
  snapshot-reason, task-9, and route-compatibility CRDT suites
- Modify/Test: extract `packages/tests/shared-server/app-crdt-inbox-service.test.ts` mutation
  decision/service scenarios to
  `packages/tests/shared-server/crdt/mutation/crdt-mutation-service.test.ts`
- Move/Test: `packages/tests/shared-server/crdt-task9-correction.test.ts` to
  `packages/tests/shared-server/crdt/mutation/crdt-command-and-outbox-invariants.test.ts`

**Interfaces:**

- Consumes: Task 1 command/read/computed/result contracts and `PSqlTransactionSql`.
- Produces: `CrdtMutationService` and `createCrdtMutationService` with the exact interface in the
  Canonical Interfaces section.

- [ ] **Step 1: Add direct RED phase and write-order assertions**

Use `git mv` for `crdt-task9-correction.test.ts`. Create the direct mutation-service suite with the
mutation decision/write scenarios extracted from `app-crdt-inbox-service.test.ts`, then remove
those exact cases from the predecessor so Task 4 can move its remaining inbox lifecycle cases.
Inventory test names and assertion sites before and after so each predecessor scenario exists once.
Import the target modules and add this direct phase assertion:

```ts
const read = await service.read(command);
const computed = service.compute({ command, read });

expect(computed.command).toBe(command);
expect(computed.read).toBe(read);
expect(service.validate({ command, read, computed })).toEqual([]);
await expect(service.write(transaction, computed)).resolves.toBe(computed.result);
expect(repository.operations).toEqual(['write-mutation', 'write-final-outbox']);
```

Also retain the existing tests for accepted append, replay, collision, policy rejection, compact,
lifecycle, rebuild, erase, result relationships, and principal/room/app outbox audiences.

Run:

```bash
npx vitest run \
  packages/tests/shared-server/crdt/mutation/crdt-mutation-service.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-command-and-outbox-invariants.test.ts
```

Expected: FAIL because the target decision and service modules do not exist.

- [ ] **Step 2: Move the cohesive decision owners**

```bash
git mv packages/shared-server/rallar-system/services/crdt-mutation-compute.ts \
  packages/shared-server/rallar-system/crdt/mutation/compute-crdt-mutation.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-validate.ts \
  packages/shared-server/rallar-system/crdt/mutation/validate-crdt-mutation.ts
git mv packages/shared-server/rallar-system/services/crdt-mutations.ts \
  packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-result-builders.ts \
  packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-result.ts
git mv packages/shared-server/rallar-system/services/crdt-mutation-outbox.ts \
  packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-outbox.ts
git mv packages/shared-server/rallar-system/services/crdt-append-rejection.ts \
  packages/shared-server/rallar-system/crdt/mutation/crdt-append-rejection.ts
git mv packages/shared-server/rallar-system/services/crdt-compact-snapshot.ts \
  packages/shared-server/rallar-system/crdt/mutation/to-crdt-canonical-snapshot.ts
```

- [ ] **Step 3: Make provenance and the transaction shell explicit**

Replace the `ReturnType` service alias with the canonical interface and keep the implementation
direct:

```ts
export function createCrdtMutationService(
    dependencies: CrdtMutationServiceDependencies
): CrdtMutationService {
    return {
        read: async (command) =>
            await dependencies.repository.readMutation(decodeCrdtMutationCommand(command)),
        compute: ({ command, read }) =>
            computeCrdtMutation({ command, read, serviceId: dependencies.serviceId }),
        validate: validateCrdtMutation,
        write: async (transaction, computed) => {
            const writer = dependencies.createWriter(transaction);
            if (computed.outcome === 'write') {
                await writer.writeMutation(computed);
            }
            await writer.writeOutbox(computed.outboxEntries);
            return computed.result;
        }
    };
}
```

Define `CrdtMutationServiceDependencies` as an interface beside the factory. Convert every
four-or-more-parameter helper in the compute and outbox owners to a named input interface. Preserve
the current executable order of clocks, hashing, policy decisions, result creation, and outbox
materialization.

Add `command` and `read` to every computed outcome in one shared computed-base creator. Implement
`validateCrdtMutation` as a pure all-issues function. It reports identity, predecessor, compact
reason, and result-codec issues in that order; it does not throw or recompute the mutation. The
inbox boundary remains responsible for throwing the first issue's existing message before the
transaction begins.

- [ ] **Step 4: Resolve decision density without fragmenting one operation**

Keep one top-level exhaustive operation switch in `computeCrdtMutation`. Give each operation a
behavior-named pure function accepting one named input. Keep the computed base plus accepted append,
replay, rejection, and accepted administration outcome construction in the lower-level
`compute-crdt-mutation-outcome.ts` owner imported by both mutation decision modules. Do not create
an operation class, visitor, manager, callback registry, or parallel outcome construction.

```ts
export interface ComputeCrdtMutationInput extends CrdtMutationAttemptFacts {
    readonly serviceId: string;
}

export function computeCrdtMutation(input: ComputeCrdtMutationInput): CrdtMutationComputed {
    switch (input.command.operation) {
        case 'append':
            return computeCrdtAppend(input);
        case 'rebuild-projection':
            return computeCrdtProjectionRebuild(input);
        case 'compact':
            return computeCrdtSnapshotCompact(input);
        case 'lifecycle':
            return computeCrdtLifecycleUpdate(input);
        case 'erase':
            return computeCrdtErase(input);
    }
}
```

- [ ] **Step 5: Run GREEN, style, and legacy searches**

```bash
npx vitest run packages/tests/shared-server/crdt/mutation
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
cd ../..
npm run check:repo-style -- --root packages/shared-server/rallar-system/crdt/mutation
rg -n "rallar-system/services/crdt-|crdt-mutations\.ts" packages apps scripts examples \
  --glob '*.ts' --glob '*.tsx'
git diff --check
```

Expected: mutation tests and typecheck pass. Remaining old-path matches are only consumers scheduled
in later Slice 1 tasks; every style warning in moved production files has a written resolved or
false-positive disposition.

- [ ] **Step 6: Commit the mutation core**

```bash
git add packages/shared-server/rallar-system/crdt/mutation \
  packages/tests/shared-server/crdt/mutation \
  packages/tests/shared-server/app-crdt-inbox-service.test.ts \
  packages/tests/shared-server/crdt-app-inbox-ingress-correction.test.ts \
  packages/shared-server/rallar-system/services/AppCrdtInboxService.ts \
  apps/api-v1/src/services/create-api-crdt-inbox-service.ts \
  apps/api-v1/src/services/create-api-mutation-inbox-factories.ts \
  apps/api-v1/test/db/pglite-crdt-app-inbox-production-correction-2.test.ts \
  apps/api-v1/test/db/pglite-crdt-app-inbox-transaction.test.ts \
  apps/api-v1/test/db/pglite-crdt-correction-3-fixtures.ts \
  apps/api-v1/test/db/pglite-crdt-public-reads-correction-4.test.ts \
  apps/api-v1/test/db/pglite-crdt-snapshot-reason-correction-6.test.ts \
  apps/api-v1/test/db/pglite-crdt-task9-correction.test.ts \
  apps/api-v1/test/routes/crdt-admin-route-compat-correction.test.ts
git commit -m "refactor(crdt): expose mutation decision phases"
```

### Task 3: Move PostgreSQL Persistence And Narrow Repository Ownership

**Files:**

- Create: `packages/shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/crdt-mutation-row-codec.ts`
- Modify: `packages/shared/crdt/crdt-hardening.ts`
- Modify: `packages/shared-server/mod.ts`
- Modify imports only: `apps/api-v1/src/composition/create-default-rallar-server.ts`
- Modify imports only: `apps/api-v1/src/services/create-api-crdt-inbox-service.ts`
- Modify imports only: the current transaction, correction-3, policy, public-read, snapshot-reason,
  and task-9 PGlite CRDT suites plus the shared CRDT fixture
- Modify imports only: `apps/api-v1/test/db/pglite-sql-adapter.test.ts`
- Modify imports only: `apps/api-v1/test/crdt/routes/crdt-admin-response-compatibility.test.ts`
- Modify imports only: the Task 1 persisted-contract invariant suite
- Create/Test: `packages/tests/shared-server/crdt/crdt-public-compatibility.test.ts`
- Remove: `packages/shared-server/postgres/crdt/psql-crdt-legacy-mutation.ts` after consolidating its
  fail-closed message into the public repository owner

**Interfaces:**

- Consumes: Task 1 repository contracts and Task 2 computed mutations.
- Produces: canonical `PSqlCrdtMutationRepository`; package-root-identical
  `PSqlCrdtLogRepository`; named `RallarCrdtAdminReadRepository` consumer contract.

- [x] **Step 1: Add RED persistence and runtime-identity coverage**

Add a package export test:

```ts
import * as sharedServer from '@shared-server/mod.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

it('keeps the package CRDT log repository on its canonical owner', () => {
    expect(sharedServer.PSqlCrdtLogRepository).toBe(PSqlCrdtLogRepository);
});
```

Add compile-time and direct behavior coverage proving API/read consumers depend only on
`RallarCrdtAdminReadRepository`. Do not construct an unknown historical option or assert that a
removed mutation method exists; those would protect synthetic compatibility rather than a
supported consumer behavior.

Update the focused PGlite imports to the target paths and run:

```bash
npx vitest run packages/tests/shared-server/crdt/crdt-public-compatibility.test.ts
cd apps/api-v1 && deno test -A \
  test/db/pglite-crdt-app-inbox-transaction.test.ts \
  test/crdt/persistence/crdt-persisted-contracts.test.ts
```

Expected: FAIL on missing canonical persistence modules.

Before production movement, add a transaction-level case to
`pglite-crdt-app-inbox-transaction.test.ts`: preinsert a byte-identical final WS outbox entry, run
the CRDT mutation attempt whose computed entry has the same key/content, and assert rejection plus
zero committed document/update/result changes. Run that one case against current main first.
Expected RED: the current `writeIfAbsentOrMatch` path reports a match and lets the mutation commit.

- [x] **Step 2: Move the PostgreSQL owners**

```bash
mkdir -p packages/shared-server/rallar-system/crdt/persistence
git mv packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts \
  packages/shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts
git mv packages/shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts \
  packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts
git mv packages/shared-server/postgres/crdt/crdt-mutation-row-codec.ts \
  packages/shared-server/rallar-system/crdt/persistence/crdt-mutation-row-codec.ts
```

Define `RallarCrdtAdminReadRepository` beside the shared CRDT administration contracts. It owns the
read/admin methods used by API-v1 and shared-server administration: `listAfter`, `readSnapshot`,
`readDocumentMetadata`, `listDocuments`, `exportDebugBundle`, `exportBackupBundle`, and
`verifyIntegrity`. Migrate each in-repository read/admin consumer to that contract.

Make `PSqlCrdtLogRepository` implement the narrow contract. Remove `append`, `appendBatch`,
`writeSnapshot`, `updateDocumentLifecycle`, `restoreBackupBundle`, and `rebuildProjection`; delete
`psql-crdt-legacy-mutation.ts`. Remove `[legacyOption: string]: unknown` plus option fields that the
class does not read, and update every constructor call. Remove or replace tests whose only behavior
was exercising the deleted rejection surface. Do not modify `docs/production-legacy-exceptions.md`:
there is no retained PostgreSQL compatibility boundary.

- [x] **Step 3: Make mutation repository dependencies required and named**

Use a type-only namespace immediately before the class:

```ts
export namespace PSqlCrdtMutationRepository {
    export interface Dependencies {
        readonly sql: PSqlSql;
        readonly authorize: ReadCrdtMutationAuthority;
    }

    export interface Config {
        readonly policies: readonly RallarCrdtDocumentTypePolicy[];
    }
}

export class PSqlCrdtMutationRepository implements CrdtMutationRepository {
    constructor(
        dependencies: PSqlCrdtMutationRepository.Dependencies,
        config: PSqlCrdtMutationRepository.Config
    ) {
        this.sql = dependencies.sql;
        this.authorize = dependencies.authorize;
        this.policies = config.policies;
    }
}
```

Update all constructions. Production supplies an authority reader and an explicit policy array.
Tests that need fail-closed behavior pass an authority returning
`{ allowed: false, code: 'current-authority-reader-missing' }`; the constructor no longer invents
that production dependency.

- [x] **Step 4: Preserve guarded write and corruption behavior**

Keep the first write as the current conditional document insert/update. Preserve the order:

```ts
const guarded = computed.expectedDocumentRevision === 'absent'
    ? await insertDocument({ sql: this.sql, metadata: computed.document })
    : await updateDocument({
        sql: this.sql,
        metadata: computed.document,
        expectedRevision: computed.expectedDocumentRevision,
        expectedLifecycle: computed.expectedDocumentLifecycle,
        expectedAppendSequence: computed.expectedAppendSequence
    });
if (!guarded) {
    throw new CrdtMutationConflictError(computed.documentKey);
}
if (computed.update && computed.append) {
    await insertUpdate({
        sql: this.sql,
        documentKey: computed.documentKey,
        update: computed.update,
        append: computed.append
    });
}
if (computed.snapshot) {
    await insertSnapshot({
        sql: this.sql,
        documentKey: computed.documentKey,
        snapshot: computed.snapshot,
        appendSequence: computed.document.lastAppendSequence
    });
}
```

Keep final outbox writing after `writeMutation` in the mutation service. Row decoding validates
physical/logical document, update, snapshot, sequence, timestamp, and reason relationships before
returning a domain value. Define named input interfaces beside the SQL helpers so the touched
persistence owner has no four-or-more-positional-parameter helper.

Change only the CRDT mutation repository's final outbox loop from
`ResourceInboxRepository.writeIfAbsentOrMatch(entry)` to the insert-only
`ResourceInboxRepository.write(entry)`. Do not change the shared repository method or unrelated
callers. The new identical-collision test must turn GREEN and prove the preceding guarded document
and update writes roll back with the collision.

- [x] **Step 5: Update the package root without a compatibility wrapper**

Change the existing direct export to:

```ts
export * from './rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
```

Do not re-export `PSqlCrdtMutationRepository`; it remains an internal construction owner unless
current package-root evidence proves otherwise.

- [x] **Step 6: Run GREEN and live persistence checks**

```bash
npx vitest run packages/tests/shared-server/crdt/crdt-public-compatibility.test.ts
cd apps/api-v1 && deno test -A \
  test/db/pglite-crdt-app-inbox-transaction.test.ts \
  test/crdt/persistence/crdt-persisted-contracts.test.ts \
  test/crdt/persistence/crdt-public-read-integrity.test.ts
deno task check
cd ../..
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run check:repo-style -- --root packages/shared-server/rallar-system/crdt/persistence
git diff --check
```

Expected: package identity, narrow consumer typing, PGlite atomicity/CAS/corruption tests,
identical outbox collision rollback, typecheck, and diff checks pass.

- [x] **Step 7: Commit persistence ownership**

```bash
git add packages/shared-server/rallar-system/crdt/persistence \
  packages/shared/crdt/crdt-hardening.ts \
  packages/shared-server/mod.ts \
  packages/tests/shared-server/crdt/crdt-public-compatibility.test.ts \
  packages/tests/shared-server/crdt/mutation/crdt-persisted-contract-invariants.test.ts \
  apps/api-v1/src/composition/create-default-rallar-server.ts \
  apps/api-v1/src/services/create-api-crdt-inbox-service.ts \
  apps/api-v1/test/db/pglite-crdt-app-inbox-transaction.test.ts \
  apps/api-v1/test/crdt/crdt-api-test-fixtures.ts \
  apps/api-v1/test/crdt/persistence/crdt-mutation-retry.test.ts \
  apps/api-v1/test/db/pglite-crdt-policy-correction-4.test.ts \
  apps/api-v1/test/crdt/persistence/crdt-public-read-integrity.test.ts \
  apps/api-v1/test/crdt/persistence/crdt-snapshot-reason.test.ts \
  apps/api-v1/test/crdt/persistence/crdt-persisted-contracts.test.ts \
  apps/api-v1/test/db/pglite-sql-adapter.test.ts \
  apps/api-v1/test/crdt/routes/crdt-admin-response-compatibility.test.ts
git commit -m "refactor(crdt): colocate PostgreSQL persistence"
```

### Task 4: Recover Inbox Ownership And Fix Audit Delivery Registration

**Current boundary:** `AppCrdtInboxService` already receives immutable audit effects at construction
and has no `setAuditSink`; this task owns only the later audit-delivery registration extraction.

**Files:**

- Create: `packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts`
- Create: `packages/shared-server/rallar-system/crdt/inbox/create-authenticated-crdt-append.ts`
- Create: `packages/shared-server/rallar-system/crdt/inbox/create-crdt-ws-mutation-ingress.ts`
- Create: `packages/shared-server/rallar-system/crdt/inbox/register-crdt-audit-delivery.ts`
- Create: `apps/api-v1/src/crdt/create-crdt-admin-mutations.ts`
- Create: `plans/repo-style-lineages/crdt-ownership.json`
- Modify: `plans/repo-style-lineages/crdt-mutation-ownership.json`
- Modify: `scripts/repo-style-check/structural-lineage.mjs`
- Modify/Test: `packages/tests/repo/repo-style-structural-lineage.test.ts`
- Modify: `apps/api-v1/src/routes/crdt-admin-routes.ts`
- Modify: `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts`
- Modify: `apps/api-v1/src/services/create-api-crdt-inbox-service.ts`
- Modify: `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-admin-services.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-route-installers.ts`
- Modify: `apps/api-v1/src/composition/create-default-rallar-server.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-system-installers.ts`
- Modify imports: `apps/api-v1/test/composition/create-api-v1-admin-services.test.ts`
- Modify imports: `apps/api-v1/test/composition/create-api-v1-route-installers.test.ts`
- Move/Test: `apps/api-v1/test/crdt/inbox/crdt-production-inbox.test.ts`
- Move/Test: `apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts`
- Modify imports: `apps/api-v1/test/routes/crdt-admin-repository-health.test.ts`
- Modify/Test: `apps/api-v1/test/routes/admin-operations-routes.test.ts`
- Move/Test: inbox tests from the migration map
- Move/Test: split `packages/tests/shared-server/admin-prune-correction-4.test.ts` according to the
  migration map
- Create/Test: `packages/tests/shared-server/crdt/inbox/crdt-audit-delivery.test.ts`
- Create/Test: `apps/api-v1/test/crdt/inbox/crdt-audit-registration-construction.test.ts`
- Modify/Test: active mutation-route owner and phase-order analyzer files under
  `packages/tests/shared-server`
- Create/Test: `packages/tests/shared-server/mutation-routing-crdt-operation.ts`
- Modify: `docs/test-structure-coupling-exceptions.md`

**Interfaces:**

- Consumes: Tasks 1-3 command/service/persistence owners, AppInbox base class, queue readers, and API
  `AuthSession` only in the API mutation owner.
- Produces: final `AppCrdtInboxService`, shared WebSocket mutation ingress, audit registration, and
  `CrdtAdminMutations` used by both CRDT routes and general admin operations.

- [x] **Step 1: Write RED construction and audit tests**

Move the remaining inbox tests exactly:

```bash
mkdir -p packages/tests/shared-server/crdt/inbox
git mv packages/tests/shared-server/app-crdt-inbox-service.test.ts \
  packages/tests/shared-server/crdt/inbox/app-crdt-inbox-service.test.ts
# Already moved early by Task 2:
# packages/tests/shared-server/crdt/inbox/crdt-app-inbox-ingress.test.ts
git mv packages/tests/shared-server/admin-prune-correction-4.test.ts \
  packages/tests/shared-server/admin-prune-retry-lifetime.test.ts
```

Keep only the semantic admin-prune successor/result horizon case in
`admin-prune-retry-lifetime.test.ts` and replace its `as never` inputs with the canonical contracts.
Create `apps/api-v1/test/crdt/inbox/crdt-admin-command-expiry.test.ts`; use a recording shared inbox
to capture compact/lifecycle/erase commands and assert their capture/expiry relationship directly.
Do not retain `Function.prototype.toString`, private-member casts, regex assertions, or the task
history suite name.

Add a recording outbox reader that overrides `onOutboxMessageDo`. Assert that no-delivery
construction succeeds without any reader dependency, while a complete delivery pair registers
exactly once:

```ts
const withoutSink = createInbox({ auditDelivery: undefined });

expect(withoutSink).toBeInstanceOf(AppCrdtInboxService);

createInbox({ auditDelivery: { outboxQueueReader, auditSink } });
expect(outboxQueueReader.registeredTypes).toEqual([CRDT_AUDIT_APP_OUTBOX_TYPE]);
```

Invoke the recorded handler with malformed content type, malformed JSON/event, a sink that fails
once, and a sink that succeeds. Assert exact failure propagation and one `record(event)` invocation
per handler invocation.

Also add compile-time assertions that `AppCrdtInboxService` has no `setAuditSink` member and that
neither `AppCrdtInboxService.Dependencies` nor `CreateApiCrdtInboxServiceInput` exposes a top-level
`outboxQueueReader`. The optional `auditDelivery` pair is the sole audit-reader registration path.

Run:

```bash
npx vitest run packages/tests/shared-server/crdt/inbox
```

Expected: FAIL because the target inbox modules and immutable constructor do not exist.

- [x] **Step 2: Move the inbox and ingress owners**

```bash
mkdir -p packages/shared-server/rallar-system/crdt/inbox apps/api-v1/src/crdt
git mv packages/shared-server/rallar-system/services/AppCrdtInboxService.ts \
  packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts
git mv packages/shared-server/rallar-system/services/crdt-authenticated-append.ts \
  packages/shared-server/rallar-system/crdt/inbox/create-authenticated-crdt-append.ts
git mv apps/api-v1/src/services/create-crdt-ws-mutation-ingress.ts \
  packages/shared-server/rallar-system/crdt/inbox/create-crdt-ws-mutation-ingress.ts
```

Remove the unused `serverId` ingress parameter. Keep the scope-to-response-audience translation in
this shared adapter because both sides are shared-server contracts.

Create the structural-lineage manifest with version 1 and exact merge base
`22bb4919c92f96d785ff65d7f308a6d2fd3318e7`. Its first lineage records source
`packages/shared-server/rallar-system/services/AppCrdtInboxService.ts`, blob
`492c477c67c182cd27657ac47218890e01a1cae7`, and these targets:

```text
packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts
packages/shared-server/rallar-system/crdt/inbox/register-crdt-audit-delivery.ts
apps/api-v1/src/crdt/create-crdt-admin-mutations.ts
```

This authenticates responsibility recovery and aggregate finding capacity to the changed-style
checker; it is not a source-file inventory, progress record, compatibility requirement, or waiver.
The obsolete source path is removed atomically after consumer closure. A discovered checker bug
previously required that source to remain for one-to-many lineages; focused regression coverage now
proves that an exact source blob and two valid targets pass after the obsolete owner is deleted.
The checker still validates the exact merge base, source blob, production paths, target existence,
target uniqueness and conflicts, stale bases, malformed manifests, aggregate capacity, and Git
rename conflicts.

The five existing mutation-codec lineages are also re-anchored from the branch-internal planning
commit `224c850bf1e3632532b49c17995a6183c8c4c7a3` to the actual pull-request merge base
`22bb4919c92f96d785ff65d7f308a6d2fd3318e7`. Their source blobs are byte-identical at both commits,
so the existing blob values remain exact. This is a provenance correction, not new finding
capacity.

- [x] **Step 3: Move the established named constructor owner and separate mixed responsibilities**

Task 1 already establishes the named `AppCrdtInboxService` constructor input. Move that established
owner without repeating the constructor replacement. The shared inbox retains only durable enqueue,
command identity validation, mutation attempt invocation, and queue wake. Move API admin request
decoding, `AuthSession` translation, public result projection, and HTTP error mapping into
`apps/api-v1/src/crdt/create-crdt-admin-mutations.ts`.

The inbox attempt remains visibly ordered:

```ts
const command = decodeCrdtMutationCommand(value);
assertCrdtAppInboxIdentity({ command, appInboxContext });
const read = await this.mutationService.read(command);
const computed = this.mutationService.compute({ command, read });
const issues = this.mutationService.validate({ command, read, computed });
if (issues[0]) {
    throw new TypeError(issues[0].message);
}
const result = await this.writeMutation(
    appInboxContext,
    async (transaction) => await this.mutationService.write(transaction, computed)
);
if (result.operation === 'erase' && result.status === 'accepted') {
    this.wakeQueueEngine();
}
return result;
```

Do not change when the queue wake occurs.

- [x] **Step 4: Implement immutable audit delivery**

`register-crdt-audit-delivery.ts` accepts both dependencies as required:

```ts
export interface RegisterCrdtAuditDeliveryInput {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly auditSink: RallarCrdtAuditSink;
}

export function registerCrdtAuditDelivery(input: RegisterCrdtAuditDeliveryInput): void {
    input.outboxQueueReader.onOutboxMessageDo(CRDT_AUDIT_APP_OUTBOX_TYPE, {
        onMessage: async (message) => {
            if (message.payload.contentType !== 'application/json') {
                throw new TypeError('CRDT audit outbox content type is invalid');
            }
            await input.auditSink.record(
                decodeCrdtAuditEvent(JSON.parse(message.payload.resource))
            );
        }
    });
}
```

The inbox constructor calls this function only when `dependencies.auditDelivery !== undefined`.
That optional field contains both the outbox reader and sink, so construction cannot represent a
reader-without-sink or sink-without-reader state. Default production omits the complete field.
`setAuditSink` and the mutable audit state were already deleted in Task 2; keep them absent while
extracting registration.

- [x] **Step 5: Create the API admin mutation owner and update both consumers**

`createCrdtAdminMutations` receives the shared inbox, clock, ID creator, and service ID. Move the
current command creation, exact request normalization, public result projection, and rejection
mapping into it. Both `crdt-admin-routes.ts` and `create-api-admin-mutation-gateway.ts` call:

```ts
await crdtAdminMutations.writeCrdtAdminMutation({
    operation: 'compact',
    adminSession,
    request
});
```

The shared inbox no longer imports `AuthSession`, receives `request: unknown`, or returns an API
public result. It exposes `writeCrdtCommandUntilCompletion`, preserving the current
`Either<AppInboxFailure, CrdtMutationResult>` contract; the API owner alone converts a left or
rejected result into the existing HTTP-facing error/result.

The general admin gateway depends on narrow typed prune, topology, and CRDT mutation ports rather
than concrete inbox classes. Its route test uses complete typed recording/failure ports and verifies
that compact, lifecycle, and erase requests retain their exact operation, session, and request at
the CRDT mutation boundary. No `as never` construction remains in that consumer.

- [x] **Step 6: Update the API inbox factory without restoring the bug**

Construct the service with named dependencies. Remove the redundant top-level
`outboxQueueReader` from `AppCrdtInboxService.Dependencies` and
`CreateApiCrdtInboxServiceInput`; the API CRDT factory no longer forwards the middleware reader into
the service. Pass `auditDelivery` only from an explicit API runtime input containing both the sink
and already-constructed outbox reader. Current default production omits it, so no handler registers
and no second reader state exists. Keep the Task 2 construction-only audit boundary: do not restore
`setAuditSink`, its former default-server reset call, or route-level `crdtAuditSink` plumbing.

Update the active route-owner and phase-order validation in the same slice. It follows CRDT admin
HTTP registrations through `create-crdt-admin-mutations.ts` and `writeCrdtAdminMutation`, then
preserves `AppCrdtInboxService.processCommand` as the terminal AppInbox owner. The WebSocket
boundary root and registration predicates use the canonical shared inbox paths. No shim or deleted
source path participates in the analyzer.

The analyzer inventory carries the exact CRDT operation discriminant for every direct and general
admin mutation row. Executable AST traversal follows the registered route through
`createCrdtAdminMutations`, the exact `createCrdtAdminCommand` switch case, terminal
`writeCrdtCommandUntilCompletion`, and `toCrdtAppInboxType`. Controlled mutations that reroute
compact to lifecycle at the direct route, general gateway, command builder, or AppInbox type
mapping must produce an operation-specific finding; generic reachability alone is insufficient.
The operation analysis preserves live dataflow rather than accepting compatible AST fragments:
the direct helper must forward `input.operation`, the command submitted to AppInbox must be the
same binding created for that mutation, and the command/type switches must return the expected
value on the live terminal path. The submitted command is created through an immutable `const`
binding; any live assignment or update before submission invalidates that proof, while an
assignment in a literal-false branch does not. The submission identifier resolves to exactly one
live preceding declaration in its nearest lexical block, so a later nested same-name declaration
cannot replace its provenance; a canonical command and submission may share a nested block. A
nearer function/arrow parameter, destructuring declaration, catch binding, or function/class
binding stops outward resolution and fails closed unless it is the required command creation; an
unrelated parameter does not hide the outer command. Executable mutants cover a hardcoded helper
operation, a second wrong submitted command, live reassignment of the submitted binding, later
nested and callback-parameter shadow decoys, literal-false correct returns followed by live
fallthrough, and dead correct route/gateway calls or command reassignment masking live behavior.

Individually review every current source-read assertion in the changed coupling registry. Replace
stale location identities after the test move, add durable security classifications for the live
operation/binding mutants, and preserve the mutation-boundary inventory classification. The exact
`22bb4919c92f96d785ff65d7f308a6d2fd3318e7` changed-range coupling gate must pass; the checker unit
suite alone is not acceptance evidence.

- [x] **Step 7: Run GREEN and the corrected PGlite audit path**

```bash
npx vitest run packages/tests/shared-server/crdt/inbox \
  packages/tests/shared-server/crdt/mutation \
  packages/tests/shared-server/admin-prune-retry-lifetime.test.ts
cd apps/api-v1 && deno test -A \
  test/crdt/inbox/crdt-admin-command-expiry.test.ts \
  test/crdt/inbox/crdt-audit-registration-construction.test.ts \
  test/crdt/inbox/crdt-production-inbox.test.ts \
  test/crdt/realtime/crdt-websocket-authority.test.ts \
  test/crdt/routes/crdt-admin-response-compatibility.test.ts \
  test/routes/admin-operations-routes.test.ts \
  test/routes/crdt-admin-repository-health.test.ts \
  test/composition/create-api-v1-admin-services.test.ts \
  test/composition/create-api-v1-route-installers.test.ts
deno task check
cd ../..
npx tsc -p packages/shared-server/tsconfig.json --noEmit
node scripts/check-test-structure-coupling.mjs --changed \
  22bb4919c92f96d785ff65d7f308a6d2fd3318e7 HEAD
git diff --check
```

Expected: no-sink construction registers no handler; configured delivery retries through Outbox;
admin responses, conflict revalidation, and WebSocket authority remain exact.

Also run the complete active route-owner/phase-order command from `rallar-testing`; its accepted
result is all 23 files and every test green. This replaces the stale pre-move assumption that
analyzer support could wait for Task 5.

- [x] **Step 8: Commit inbox and audit ownership**

```bash
git add packages/shared-server/rallar-system/crdt/inbox \
  plans/repo-style-lineages/crdt-ownership.json \
  packages/tests/shared-server/crdt/inbox \
  packages/tests/shared-server/admin-prune-retry-lifetime.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/mutation-boundary-analysis.ts \
  packages/tests/shared-server/mutation-boundary-traversal.ts \
  packages/tests/shared-server/mutation-routing-inventory-decoding.ts \
  packages/tests/shared-server/mutation-routing-markers.ts \
  packages/tests/shared-server/mutation-routing-crdt-operation.ts \
  packages/tests/shared-server/mutation-routing-owner-inventory.ts \
  packages/tests/shared-server/mutation-routing-reachability.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts \
  docs/test-structure-coupling-exceptions.md \
  apps/api-v1/src/crdt/create-crdt-admin-mutations.ts \
  apps/api-v1/src/routes/crdt-admin-routes.ts \
  apps/api-v1/src/services/create-api-admin-mutation-gateway.ts \
  apps/api-v1/src/services/create-api-crdt-inbox-service.ts \
  apps/api-v1/src/services/create-api-mutation-inbox-factories.ts \
  apps/api-v1/src/composition/create-api-v1-admin-services.ts \
  apps/api-v1/src/composition/create-api-v1-route-installers.ts \
  apps/api-v1/src/composition/create-default-rallar-server.ts \
  apps/api-v1/src/composition/create-api-v1-system-installers.ts \
  apps/api-v1/test/composition/create-api-v1-admin-services.test.ts \
  apps/api-v1/test/composition/create-api-v1-route-installers.test.ts \
  apps/api-v1/test/crdt/routes/crdt-admin-response-compatibility.test.ts \
  apps/api-v1/test/routes/admin-operations-routes.test.ts \
  apps/api-v1/test/routes/crdt-admin-repository-health.test.ts \
  apps/api-v1/test/crdt/inbox/crdt-audit-registration-construction.test.ts \
  apps/api-v1/test/crdt/inbox/crdt-production-inbox.test.ts \
  apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts \
  apps/api-v1/test/crdt/inbox/crdt-admin-command-expiry.test.ts
git commit -m "fix(crdt): make audit delivery construction explicit"
```

### Task 5: Consolidate Realtime And In-Memory Persistence Ownership

**Files:**

- Create: `packages/shared-server/rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts`
- Create: `packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts`
- Create: `packages/shared-server/rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts`
- Create: `packages/shared-server/rallar-system/crdt/realtime/validate-rallar-crdt-catch-up-envelope.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/in-memory-crdt-document-store.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/compute-in-memory-crdt-append.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/in-memory-crdt-append.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/in-memory-crdt-administration.ts`
- Create: `packages/shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts`
- Create: `packages/shared-server/rallar-system/crdt/README.md`
- Modify: `plans/repo-style-lineages/crdt-ownership.json`
- Modify: `packages/shared-server/mod.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-system-installers.ts`
- Modify imports: `apps/api-v1/test/composition/create-api-v1-admin-services.test.ts`
- Modify imports: `apps/api-v1/test/composition/create-api-v1-route-installers.test.ts`
- Modify imports: `apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts`
- Modify imports: `apps/api-v1/test/routes/crdt-admin-repository-health.test.ts`
- Modify: the remaining realtime-server path in mutation-boundary analyzer support files; Task 4
  already migrated canonical inbox and API admin ownership
- Move/Test: realtime and in-memory tests from the migration map
- Remove: `packages/shared-server/crdt/` after consumer closure

**Interfaces:**

- Consumes: Task 4 shared ingress and existing shared CRDT protocol/log repository contracts.
- Produces: direct protocol installation and validation owners, minimized public in-memory
  repository ownership, stable package-root exports, and durable feature navigation.

- [ ] **Step 1: Move behavior tests and verify target-path RED**

```bash
mkdir -p packages/tests/shared-server/crdt/realtime \
  packages/tests/shared-server/crdt/persistence
git mv packages/tests/shared-server/rallar-crdt-server-topic.test.ts \
  packages/tests/shared-server/crdt/realtime/rallar-crdt-server.test.ts
git mv packages/tests/shared-server/rallar-crdt-log-repository.test.ts \
  packages/tests/shared-server/crdt/persistence/in-memory-crdt-log-repository.test.ts
npx vitest run \
  packages/tests/shared-server/crdt/realtime/rallar-crdt-server.test.ts \
  packages/tests/shared-server/crdt/persistence/in-memory-crdt-log-repository.test.ts
```

Expected: FAIL on missing canonical realtime and persistence imports.

- [ ] **Step 2: Split realtime by protocol responsibility**

Move exported constants and protocol types to `rallar-crdt-server-contracts.ts`. Move installation,
topic definition, authorization invocation, accepted-envelope handling, and catch-up response to
`install-rallar-crdt-ws-topics.ts`. Move live update validation and catch-up request/response
validation to their named validators.

Keep the public `validateRallarCrdtServerLiveEnvelope` symbol and package-root runtime identity, but
make its only call shape one `ValidateRallarCrdtServerLiveEnvelopeInput`. Migrate every supported
caller and compile-time assertion in this repository in the same task. The workspace package is
private and the repository contains the complete supported consumer set, so tests and internal
types are migration targets rather than reasons to retain the five-argument shape. Do not add an
overload, rest tuple, positional adapter, compatibility alias, static disposition, or
production-legacy registry entry.

Preserve this registration/runtime sequence:

```text
construct repository + required mutation ingress
  -> install topic definitions and callbacks
  -> first callback may execute only after installation returns

incoming WS message
  -> exact protocol and size validation
  -> scope and current authorization
  -> required durable mutation ingress exactly once
  -> transport acceptance or exact rejection
```

No live append, lifecycle decision, or fanout is added to the protocol owner.

Append two exact lineages to `crdt-ownership.json`:

```text
source packages/shared-server/crdt/RallarCrdtServer.ts
blob a79908adf2425460ee1292453a990418aadee0cd
targets realtime/rallar-crdt-server-contracts.ts,
        realtime/install-rallar-crdt-ws-topics.ts,
        realtime/validate-rallar-crdt-server-live-envelope.ts,
        realtime/validate-rallar-crdt-catch-up-envelope.ts

source packages/shared-server/crdt/InMemoryRallarCrdtLogRepository.ts
blob 8bb63b7b59b4616f43aee77584ed52edbf88727a
targets persistence/in-memory-crdt-document-store.ts,
        persistence/compute-in-memory-crdt-append.ts,
        persistence/in-memory-crdt-append.ts,
        persistence/in-memory-crdt-administration.ts,
        persistence/in-memory-crdt-log-repository.ts
```

All target paths use the full
`packages/shared-server/rallar-system/crdt/` prefix in the JSON. Keep the one manifest exact-keyed;
do not add counts, completion state, or delivery metadata.

- [ ] **Step 3: Split in-memory storage without duplicating behavior**

Create one `InMemoryCrdtDocumentStore` that owns the document map and `get`, `read`, `write`, and
`entries` memory operations. `compute-in-memory-crdt-append.ts` receives an immutable state snapshot
and returns a typed append decision plus the next document state. `in-memory-crdt-append.ts` owns
the stateful read/compute/write append and batch lifecycle. `in-memory-crdt-administration.ts` owns
list, debug/backup export, restore, integrity, lifecycle, and rebuild operations over the same
store.

Keep `InMemoryRallarCrdtLogRepository` as the canonical package-public repository owner. It
constructs the store and the two cohesive owners once and delegates the existing public methods.
It contains no duplicate policy, quota, hash, lifecycle, audit, or projection decision.

```ts
export class InMemoryRallarCrdtLogRepository<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
    private readonly documents: InMemoryCrdtDocumentStore<TPayload, TValue>;
    private readonly append: InMemoryCrdtAppend<TPayload, TValue>;
    private readonly administration: InMemoryCrdtAdministration<TPayload, TValue>;

    constructor(options: InMemoryRallarCrdtLogRepositoryOptions<TPayload> = {}) {
        this.documents = createInMemoryCrdtDocumentStore();
        const config = {
            now: options.now ?? Date.now,
            serverId: options.serverId,
            validation: options.validation,
            hooks: options.hooks,
            policies: options.policies ?? [],
            metrics: options.metrics,
            audit: options.audit
        };
        this.append = createInMemoryCrdtAppend({
            documents: this.documents,
            config
        });
        this.administration = createInMemoryCrdtAdministration({
            documents: this.documents,
            config
        });
    }
}
```

The optional public constructor shape is retained because it is the canonical supported package
API, not a deprecated wrapper. Defaults are resolved once in this public constructor and are not
repeated below it.

- [ ] **Step 4: Update direct public exports**

Replace the old root exports with direct canonical exports:

```ts
export * from './rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
export * from './rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
export * from './rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
export * from './rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts';
```

Extend `crdt-public-compatibility.test.ts` to assert runtime identity for the in-memory class and
`installRallarCrdtWsTopics`, `validateRallarCrdtServerLiveEnvelope`,
`RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES`, and
`RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES`. Add type-only assignments for every current
`RallarCrdtServer*` type and both repository option types. Do not export inbox, mutation, writer,
row-codec, or API construction internals.

- [ ] **Step 5: Update the mutation-boundary analyzer semantically**

Update these support files to canonical CRDT paths and markers:

```text
packages/tests/shared-server/mutation-boundary-analysis.ts
packages/tests/shared-server/mutation-boundary-traversal.ts
packages/tests/shared-server/mutation-routing-inventory-decoding.ts
packages/tests/shared-server/mutation-routing-markers.ts
packages/tests/shared-server/mutation-routing-owner-inventory.ts
packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts
packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts
packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
```

The inventory points WebSocket entry to `install-rallar-crdt-ws-topics.ts`, all five command types
to `app-crdt-inbox-service.ts`, and HTTP/admin entry to
`apps/api-v1/src/crdt/create-crdt-admin-mutations.ts`. Retain the analyzer's semantic negative
mutations; do not add an exact final file-count assertion.

- [ ] **Step 6: Write the durable CRDT navigation map**

`README.md` contains:

```text
Public entry: packages/shared-server/mod.ts
Realtime entry: realtime/install-rallar-crdt-ws-topics.ts
Durable inbox entry: inbox/app-crdt-inbox-service.ts
Mutation phases: mutation/create-crdt-mutation-service.ts
PostgreSQL conditional write: persistence/psql-crdt-mutation-repository.ts
Read/admin repositories: persistence/*-crdt-log-repository.ts
Final effects: mutation/create-crdt-mutation-outbox.ts and inbox/register-crdt-audit-delivery.ts
API composition: apps/api-v1/src/crdt/
```

Also document the WebSocket append, AppInbox retry, admin mutation, read-only catch-up, and erasure
audit paths in concise owner-to-result order.

- [ ] **Step 7: Remove old paths after exact consumer closure**

```bash
rg -n "@shared-server/crdt/|@shared-server/postgres/crdt/|rallar-system/services/crdt-|AppCrdtInboxService\.ts" \
  packages apps scripts examples docs --glob '*.ts' --glob '*.tsx' --glob '*.md'
find packages/shared-server/crdt packages/shared-server/postgres/crdt -type f -print
```

Expected: no live source/test/docs import uses an old path, and both old directories are absent.
Historical plans may mention old paths and are not rewritten.

- [ ] **Step 8: Run GREEN and structural closure**

```bash
npx vitest run packages/tests/shared-server/crdt \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
cd ../..
npm run check:repo-style -- --root packages/shared-server/rallar-system/crdt
npm run check:repo-structure -- --base 22bb4919c92f96d785ff65d7f308a6d2fd3318e7
npm run test:repo-structure
npm run review:legacy -- 22bb4919c92f96d785ff65d7f308a6d2fd3318e7 HEAD \
  --registry docs/production-legacy-exceptions.md
npx prettier --check packages/shared-server/rallar-system/crdt packages/tests/shared-server/crdt
git diff --check
```

Expected: semantic suites pass; no unresolved touched-file style violation remains; structure
findings have explicit keep/split/move/consolidate judgments.

- [ ] **Step 9: Commit the complete shared feature boundary**

```bash
git add packages/shared-server/rallar-system/crdt \
  packages/shared-server/mod.ts \
  plans/repo-style-lineages/crdt-ownership.json \
  packages/tests/shared-server/crdt \
  packages/tests/shared-server/mutation-boundary-analysis.ts \
  packages/tests/shared-server/mutation-boundary-traversal.ts \
  packages/tests/shared-server/mutation-routing-inventory-decoding.ts \
  packages/tests/shared-server/mutation-routing-markers.ts \
  packages/tests/shared-server/mutation-routing-owner-inventory.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  apps/api-v1/src/composition/create-api-v1-system-installers.ts \
  apps/api-v1/test/composition/create-api-v1-admin-services.test.ts \
  apps/api-v1/test/composition/create-api-v1-route-installers.test.ts \
  apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts \
  apps/api-v1/test/routes/crdt-admin-repository-health.test.ts
git commit -m "refactor(crdt): consolidate server ownership"
```

### Task 6: Close And Publish Slice 1

**Files:**

- Modify only if findings require: changed Slice 1 production/tests/docs
- Create ignored report: `.superpowers/sdd/2026-08-17-crdt-ownership/task-6-report.md`
- No tracked ledger, receipt, digest, catalog, or status file

**Interfaces:**

- Consumes: Tasks 1-5 exact head.
- Produces: reviewable PR A with a clean canonical shared CRDT owner and a stable base for PR B.

- [ ] **Step 1: Perform the two required code-derived traces**

Without using the design or plan as a map, start from `packages/shared-server/mod.ts` and record:

1. construction/registration: API runtime creates repositories, authority, mutation service, inbox,
   audit registration, WebSocket ingress, and topic installer before any callback can run;
2. runtime invocation: WebSocket append and HTTP admin variants through decode, authority, read,
   compute, validate, transaction, first guard, records, result, final outbox, commit return,
   post-commit delivery/wake, and caller-visible result.

The trace must name conflict retry re-entry and prove no API `AuthSession` or HTTP request reaches the
shared inbox/mutation owners.

- [ ] **Step 2: Complete production legacy review**

Classify every affected candidate as `removed`, `minimized-boundary`, `resolved`, or `retained`.
The PostgreSQL direct-mutation/options surface and five-argument realtime-validator shape are
expected `removed`. `InMemoryRallarCrdtLogRepository` and the named-input public validator are
canonical public implementations, not legacy. Any retained candidate stops publication for
explicit maintainer approval and registry work.

- [ ] **Step 3: Run Slice 1 validation**

```bash
npx vitest run packages/tests/shared-server/crdt \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
cd ../..
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:changed -- 22bb4919c92f96d785ff65d7f308a6d2fd3318e7 HEAD
npm run check:repo-structure -- --base 22bb4919c92f96d785ff65d7f308a6d2fd3318e7
npm run test:repo-structure
npm run review:legacy -- 22bb4919c92f96d785ff65d7f308a6d2fd3318e7 HEAD \
  --registry docs/production-legacy-exceptions.md
npx prettier --check \
  packages/shared-server/rallar-system/crdt \
  packages/tests/shared-server/crdt \
  apps/api-v1/src/crdt
git diff --check 22bb4919c92f96d785ff65d7f308a6d2fd3318e7...HEAD
```

Expected: all focused/package/governance/format checks pass. Full style may exit 0 with unrelated
warning output; every changed-file finding must be resolved or demonstrated false positive.

- [ ] **Step 4: Create draft PR A and check delivery state**

Use `rallar-repo:publishing-plan-progress`. Push only the feature branch, create the draft PR with
Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up, then run:

```bash
npm run pr:delivery -- status
```

Repair only a reported real conflict or failed check. `BEHIND` alone is not work while GitHub says
the PR is mergeable.

- [ ] **Step 5: Commit any evidence-driven correction and request review**

After corrections and a clean review, inspect the exact changed paths. If review caused changes,
stage only the known Slice 1 closure and commit:

```bash
git diff --name-only
git add packages/shared-server/rallar-system/crdt \
  packages/shared-server/mod.ts \
  packages/tests/shared-server/crdt \
  packages/tests/shared-server/mutation-boundary-analysis.ts \
  packages/tests/shared-server/mutation-routing-inventory-decoding.ts \
  packages/tests/shared-server/mutation-routing-markers.ts \
  packages/tests/shared-server/mutation-routing-owner-inventory.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  apps/api-v1/src/crdt \
  apps/api-v1/src/composition \
  apps/api-v1/src/services/create-api-admin-mutation-gateway.ts
git commit -m "fix(crdt): close core ownership review"
```

Before committing, compare the staged path list with `git diff --name-only` and unstage anything not
actually changed by the review. If no file changed, do not create an empty commit. Run
`npm run pr:delivery -- ready` once at handoff.

---

## Slice 2 / PR B — Administration And Consumer Alignment

### Task 7: Move API CRDT Authorization And Construction Into The Feature Boundary

**Files:**

- Create: `apps/api-v1/src/crdt/create-api-crdt-document-authorizer.ts`
- Create: `apps/api-v1/src/crdt/create-api-crdt-inbox-service.ts`
- Create: `apps/api-v1/src/crdt/create-api-crdt-inbox-factory.ts`
- Modify: `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-route-installers.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-runtime.ts`
- Modify: `apps/api-v1/test/composition/create-api-v1-mutation-runtime.test.ts`
- Modify imports: the current production, correction-3, snapshot-reason, and WebSocket-authority
  PGlite CRDT suites
- Move/Test: `packages/tests/shared-server/rallar-middleware-crdt-principal-correction-4.test.ts`
  to `packages/tests/shared-server/crdt/realtime/crdt-principal-fanout-cold-cache.test.ts`
- Move/Test: `apps/api-v1/test/db/pglite-crdt-policy-correction-4.test.ts` to
  `apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts` when its factory import
  moves; touched-file closure does not retain the correction-named path until Task 9.
- Remove: old API CRDT service files after import closure
- Test: focused PGlite policy, authority, and production-factory suites

**Interfaces:**

- Consumes: PR A shared inbox, mutation, persistence, and authority contracts.
- Produces: explicit API CRDT document authorizer, inbox service construction, and the one CRDT
  middleware factory consumed by API mutation composition.

- [ ] **Step 1: Fork and lock the stacked Slice 2 base**

After PR A has merged, create PR B from the exact merged `main` commit. PR A used a squash merge, so
replaying its pre-merge feature branch would duplicate the Slice 1 history:

```bash
git switch main
git pull --ff-only
git switch -c codex/crdt-api-alignment
git merge-base --is-ancestor main HEAD
git status --short
```

Expected: the ancestry check exits 0 and the new branch is clean. Record the immutable merged-main
commit as the exact Slice 2 comparison base.

- [ ] **Step 2: Add RED direct factory tests at the final paths**

Extend the Task 4-moved `crdt-production-inbox.test.ts` and create
`crdt-document-authority.test.ts` under `apps/api-v1/test/crdt/inbox/`; import the final API CRDT
modules. Add direct assertions that the factory supplies current-session authority, exact policy
configuration, required queue wake, and no audit delivery pair by default. Do not create a second
production-inbox suite or restore its correction-named source path.

```bash
cd apps/api-v1 && deno test -A \
  test/crdt/inbox/crdt-production-inbox.test.ts \
  test/crdt/inbox/crdt-document-authority.test.ts
```

Expected: FAIL because the final API CRDT factory modules do not exist.

- [ ] **Step 3: Move and separate current responsibilities**

```bash
git mv apps/api-v1/src/services/create-api-crdt-document-authorizer.ts \
  apps/api-v1/src/crdt/create-api-crdt-document-authorizer.ts
git mv apps/api-v1/src/services/create-api-crdt-inbox-service.ts \
  apps/api-v1/src/crdt/create-api-crdt-inbox-service.ts
git mv packages/tests/shared-server/rallar-middleware-crdt-principal-correction-4.test.ts \
  packages/tests/shared-server/crdt/realtime/crdt-principal-fanout-cold-cache.test.ts
mkdir -p apps/api-v1/test/crdt/configuration
git mv apps/api-v1/test/db/pglite-crdt-policy-correction-4.test.ts \
  apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts
```

Remove the unused `createApiCrdtMutationInboxFactories` function currently colocated with the
document authorizer. Move CRDT policy reading and the CRDT half of middleware factory creation into
`create-api-crdt-inbox-factory.ts`. Keep admin inbox creation in the general mutation-factory owner.

- [ ] **Step 4: Close API authorizer and construction standards**

Convert `authorizeCurrentClientDocument` to one named input interface:

```ts
interface AuthorizeCurrentClientDocumentInput {
    readonly applicationId: string;
    readonly workspaceId: string | undefined;
    readonly principalId: string;
    readonly sessionId: string;
}
```

Keep the document authorization order exact: response audience/document relationship, then room or
client snapshot, then active membership/session and expiry. Preserve one `nowEpochMs()` read at the
same decision boundary per current invocation.

- [ ] **Step 5: Run GREEN and Deno closure**

```bash
cd apps/api-v1
deno test -A test/crdt/inbox test/crdt/configuration/crdt-policy-configuration.test.ts
deno task check
deno fmt --check src/crdt test/crdt
cd ../..
npm run check:repo-style -- --root apps/api-v1/src/crdt
git diff --check
```

Expected: factory, authority, policy, Deno check, formatting, and changed style pass.

Also run the moved cross-package consumer directly:

```bash
npx vitest run packages/tests/shared-server/crdt/realtime/crdt-principal-fanout-cold-cache.test.ts
```

Expected: the cold-cache and current-session principal fanout behavior remains exact through the
new API authorizer path.

- [ ] **Step 6: Commit API construction ownership**

```bash
git add apps/api-v1/src/crdt \
  apps/api-v1/src/services/create-api-mutation-inbox-factories.ts \
  apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts \
  apps/api-v1/src/composition/create-api-v1-route-installers.ts \
  apps/api-v1/src/composition/create-api-v1-runtime.ts \
  apps/api-v1/test/composition/create-api-v1-mutation-runtime.test.ts \
  apps/api-v1/test/crdt/inbox/crdt-production-inbox.test.ts \
  apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts \
  apps/api-v1/test/crdt/persistence/crdt-mutation-retry.test.ts \
  apps/api-v1/test/crdt/persistence/crdt-snapshot-reason.test.ts \
  apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts \
  apps/api-v1/test/crdt \
  packages/tests/shared-server/crdt/realtime/crdt-principal-fanout-cold-cache.test.ts
git add -u apps/api-v1/test/db/pglite-crdt-policy-correction-4.test.ts
git commit -m "refactor(api-v1): colocate CRDT construction"
```

### Task 8: Move CRDT Routes And Align Both Administration Surfaces

**Current path ruling:** `crdt-admin-response-compatibility.test.ts` already lives under
`apps/api-v1/test/crdt/routes/`; move only the remaining route suites in this task.

**Files:**

- Create: `apps/api-v1/src/crdt/register-crdt-admin-routes.ts`
- Modify: `apps/api-v1/src/crdt/create-crdt-admin-mutations.ts`
- Modify: `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-admin-services.ts`
- Modify: `apps/api-v1/src/composition/create-api-v1-route-installers.ts`
- Modify: `apps/api-v1/src/composition/create-default-rallar-server.ts`
- Modify: `packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts`
- Modify: `packages/tests/shared-server/mutation-routing-inventory-decoding.ts`
- Modify: `packages/tests/shared-server/mutation-routing-markers.ts`
- Move/Test: all API route tests into `apps/api-v1/test/crdt/routes/`
- Remove: `apps/api-v1/src/routes/crdt-admin-routes.ts`

**Interfaces:**

- Consumes: PR A `CrdtAdminMutations` and Task 7 authorizer/construction.
- Produces: one API admin mutation capability shared by `/api/crdt/admin/**` and
  `/api/admin/operations/crdt/**`, plus direct read-only route ownership.

- [ ] **Step 1: Move route tests and verify RED on final owner**

```bash
mkdir -p apps/api-v1/test/crdt/routes
git mv apps/api-v1/test/routes/crdt-admin-routes.test.ts \
  apps/api-v1/test/crdt/routes/crdt-admin-mutation-routing.test.ts
# Already moved early by Task 2:
# apps/api-v1/test/crdt/routes/crdt-admin-response-compatibility.test.ts
git mv apps/api-v1/test/routes/crdt-admin-repository-health.test.ts \
  apps/api-v1/test/crdt/routes/crdt-admin-read-operations.test.ts
git mv apps/api-v1/test/routes/crdt-catch-up-authorization.test.ts \
  apps/api-v1/test/crdt/routes/crdt-catch-up-authorization.test.ts
cd apps/api-v1 && deno test -A test/crdt/routes
```

Expected: FAIL on the final route module import.

- [ ] **Step 2: Move and split route responsibilities**

```bash
git mv apps/api-v1/src/routes/crdt-admin-routes.ts \
  apps/api-v1/src/crdt/register-crdt-admin-routes.ts
```

Keep route handlers at or below 30 lines. Decode the request once, call either the direct read
repository or `CrdtAdminMutations`, and map the existing response. Remove the unused route `audit`
option and every composition field that existed only to pass it.

- [ ] **Step 3: Make both admin surfaces share one mutation capability**

Construct `CrdtAdminMutations` once in `create-default-rallar-server.ts`. Pass the same instance to
`createApiV1AdminServices` and `createApiV1RouteInstallers`. Replace all direct
`AppCrdtInboxService.processAdminMutationUntilCompletion` calls with the API-owned
`CrdtAdminMutations.writeCrdtAdminMutation` capability.

The generic admin gateway becomes:

```ts
compactCrdt: async (request) =>
  await input.crdtAdminMutations.writeCrdtAdminMutation({
    operation: 'compact',
    adminSession: request.adminSession,
    request: request.request,
  }),
```

Use the corresponding operation for lifecycle and erase. Preserve topology and prune branches.

- [ ] **Step 4: Prove mutating-versus-read routing and HTTP compatibility**

Retain and strengthen tests so:

- rebuild, compact, lifecycle, and erase invoke `writeCrdtAdminMutation` exactly once;
- list, integrity, debug export, backup export, and catch-up call only the log repository;
- no mutating route can fall back to `PSqlCrdtLogRepository` methods;
- 401, 403, 404, 409, 429, and 503 mapping remains exact;
- compact/lifecycle/rebuild/erase public result shapes and field order remain exact;
- audit APP outbox is committed before external delivery and route success does not depend on an
  external sink.

- [ ] **Step 5: Run GREEN**

```bash
cd apps/api-v1
deno test -A test/crdt/routes test/composition/create-api-v1-route-installers.test.ts \
  test/composition/create-api-v1-admin-services.test.ts \
  test/routes/admin-operations-routes.test.ts
deno task check
deno fmt --check src/crdt test/crdt
cd ../..
npm run check:repo-style -- --root apps/api-v1/src/crdt
npx vitest run \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts
git diff --check
```

Expected: route, general-admin, composition, Deno, formatting, and style checks pass.

- [ ] **Step 6: Commit API administration alignment**

```bash
git add apps/api-v1/src/crdt \
  apps/api-v1/src/services/create-api-admin-mutation-gateway.ts \
  apps/api-v1/src/composition/create-api-v1-admin-services.ts \
  apps/api-v1/src/composition/create-api-v1-route-installers.ts \
  apps/api-v1/src/composition/create-default-rallar-server.ts \
  apps/api-v1/test/crdt \
  apps/api-v1/test/composition/create-api-v1-route-installers.test.ts \
  apps/api-v1/test/composition/create-api-v1-admin-services.test.ts \
  apps/api-v1/test/routes/admin-operations-routes.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/mutation-routing-inventory-decoding.ts \
  packages/tests/shared-server/mutation-routing-markers.ts
git commit -m "refactor(api-v1): align CRDT administration"
```

### Task 9: Migrate Persistence Tests, Active Consumers, And Navigation

**Current path ruling:** the correction-3 fixture and public-read, snapshot-reason, persisted-
contracts, and correction-3 CRDT cases were moved early by Task 2. Task 4 review also moved the
production-inbox and WebSocket-authority suites. Task 9 owns only the remaining PGlite CRDT
inventory and must not recreate historical correction-named paths.

**Files:**

- Move: every `apps/api-v1/test/db/pglite-crdt-*.test.ts` to behavior-named files under
  `apps/api-v1/test/crdt/{configuration,inbox,persistence}/`
- Consume: existing `apps/api-v1/test/crdt/crdt-api-test-fixtures.ts` and
  `apps/api-v1/test/db/pglite-admin-prune-cutoff-and-expiry.test.ts`; Task 2 already completed the
  correction-3 split and prune extraction.
- Modify: current examples/docs that link to old CRDT owners
- Modify: `docs/rallar-crdt-guide.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md` when its current source map mentions
  moved CRDT owners
- Test: complete API CRDT Deno inventory and repository-governance suites

**Interfaces:**

- Consumes: final shared and API CRDT owners.
- Produces: behavior-named mirrored tests, canonical current consumers, and a cold-navigable feature
  with no old-path dependency.

- [ ] **Step 1: Rename every materially touched PGlite CRDT suite by behavior**

Task 7 already moved the three policy-configuration cases when their production owner moved. The
one remaining PGlite CRDT file contains three `Deno.test` cases. Use those current test names as
the mapping authority. Its destination is the AppInbox-atomicity file; the other listed behavior
paths already exist and are inputs to final inventory validation:

```text
apps/api-v1/test/crdt/configuration/crdt-policy-configuration.test.ts
apps/api-v1/test/crdt/inbox/crdt-production-inbox.test.ts
apps/api-v1/test/crdt/realtime/crdt-websocket-authority.test.ts
apps/api-v1/test/crdt/persistence/crdt-app-inbox-atomicity.test.ts
apps/api-v1/test/crdt/persistence/crdt-app-inbox-conflict-retry.test.ts
apps/api-v1/test/crdt/persistence/crdt-legacy-snapshot-migration.test.ts
apps/api-v1/test/crdt/persistence/crdt-persisted-contracts.test.ts
apps/api-v1/test/crdt/persistence/crdt-public-read-integrity.test.ts
apps/api-v1/test/crdt/persistence/crdt-snapshot-reason.test.ts
apps/api-v1/test/db/pglite-admin-prune-cutoff-and-expiry.test.ts
```

Move the remaining atomicity cases exactly once. Delete that final correction-named file only after
an executable name inventory proves every remaining predecessor case has one destination and no
destination duplicates one. The configuration, production, and WebSocket suites are already at
their final paths and are not moved or merged again.

- [ ] **Step 2: Update all canonical consumers**

Run:

```bash
rg -l "@shared-server/(crdt|postgres/crdt|rallar-system/services/(AppCrdtInboxService|crdt-))" \
  packages apps scripts examples --glob '*.ts' --glob '*.tsx'
```

Update shared-server internals, API construction, scripts, examples, and tests to canonical direct
owners. A consumer uses `packages/shared-server/mod.ts` only when it consumes one of the preserved
public installer, validator, constant, or repository names. The shared-test state-write evidence
codec imports the canonical command codec directly; it does not receive a compatibility wrapper.

- [ ] **Step 3: Update active navigation without rewriting history**

Update current guides and source maps to point to:

```text
packages/shared-server/rallar-system/crdt/README.md
packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts
packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts
packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts
packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts
apps/api-v1/src/crdt/register-crdt-admin-routes.ts
```

Historical plans remain unchanged except the approved design and this implementation plan.

- [ ] **Step 4: Run the complete CRDT test inventory**

```bash
npx vitest run packages/tests/shared-server/crdt
cd apps/api-v1
deno test -A test/crdt
deno task check
cd ../..
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run test:repo-governance
```

Expected: shared CRDT, API CRDT, Deno, TypeScript, and navigation governance pass.

- [ ] **Step 5: Run the cold code-only trace**

Starting only at `packages/shared-server/mod.ts` and
`apps/api-v1/src/composition/create-default-rallar-server.ts`, locate:

- WebSocket append entry and rejection;
- current-session and document authority;
- command identity and decoder;
- read, compute, validate, guarded write, final outbox, result, and retry;
- read-only catch-up;
- mutating admin command construction and public result;
- erasure audit commit and optional external delivery.

Fail the task if any owner requires a wrong-file guess, ambiguous duplicate, pass-through hop,
hidden callback, or use of this plan as a map. Perform one coherent consolidation and rerun before
escalating.

- [ ] **Step 6: Commit consumer and navigation closure**

```bash
git add apps/api-v1/test/crdt \
  apps/api-v1/test/db/pglite-admin-prune-cutoff-and-expiry.test.ts \
  docs/rallar-crdt-guide.md \
  docs/rallar-convergent-state-and-rtc-topology.md
git add -u \
  apps/api-v1/test/db/pglite-crdt-app-inbox-transaction.test.ts
git commit -m "test(crdt): align consumers and navigation"
```

Do not stage a current guide that had no CRDT path change.

### Task 10: Run Final Correctness, Database, Black-Box, Performance, And Delivery Gates

**Files:**

- Modify only for classified regressions or invalid assumptions
- Create ignored report: `.superpowers/sdd/2026-08-17-crdt-ownership/task-10-report.md`
- No tracked plan status, receipt, digest, or post-merge record

**Interfaces:**

- Consumes: final PR B candidate.
- Produces: immutable review head with complete correctness, performance, legacy, navigation, and
  delivery evidence.

- [ ] **Step 1: Run focused and package checks**

```bash
npx vitest run packages/tests/shared-server/crdt \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1
deno test -A test/crdt
deno task check
cd ../..
```

Expected: all focused shared/API tests and both type systems pass.

- [ ] **Step 2: Run live PostgreSQL integration in the required order**

```bash
npm run db:test:up
npm run test:postgres:integration
npm run test:postgres:presence-expiry
```

Run presence expiry last because it retains fixed-ID outbox evidence. Classify an unavailable local
database as skipped infrastructure, not pass evidence.

- [ ] **Step 3: Run API-v1 CRDT and convergent black-box gates**

```bash
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:crdt
npm run test:api-v1:black-box:postgres:medium-scale
```

The medium-scale gate remains 100 independently authenticated clients, five groups, three API
processes, 10 client lanes, and 5 control lanes. Do not weaken timeouts, topology, workload, or
assertions. Inspect all A/B/C server logs and current-run fairness evidence before changing code on
failure.

- [ ] **Step 4: Capture and compare the required state-write candidate**

Against another freshly migrated database:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

Expected: artifact validation, receipt/outbox linkage, retry exhaustion, latency, throughput,
SQL/row/byte counts, and transaction-duration comparison pass. On a noisy host, use the documented
order-balanced A-B-B-A pooling protocol before declaring a regression. Do not claim this harness
measures CRDT-specific throughput.

- [ ] **Step 5: Run repository closure and complete human review**

```bash
npm run check:repo-style
npm run check:repo-style:changed -- codex/crdt-ownership-design HEAD
npm run check:repo-structure -- --base codex/crdt-ownership-design
npm run test:repo-structure
npm run test:repo-governance
npm run review:legacy -- codex/crdt-ownership-design HEAD \
  --registry docs/production-legacy-exceptions.md
npx prettier --check packages/shared-server/rallar-system/crdt packages/tests/shared-server/crdt
cd apps/api-v1 && deno fmt --check src/crdt test/crdt
cd ../..
git diff --check codex/crdt-ownership-design...HEAD
```

`codex/crdt-ownership-design` is the immutable PR A head from which Task 7 created PR B. Review
every changed file in full, disposition every construction/style finding, and classify every
affected legacy candidate. Unrelated full-repository warnings are reported but do not authorize a
touched violation.

Confirm that issue [#265](https://github.com/intact-software-systems/ar-eye-hunter/issues/265)
remains the explicit owner for the unchanged append full-history read/decode weakness. Do not close
it from this refactor or describe the general state-write harness as CRDT append evidence.

- [ ] **Step 6: Authenticate public and removed-path closure**

```bash
rg -n "@shared-server/crdt/|@shared-server/postgres/crdt/|rallar-system/services/crdt-|AppCrdtInboxService\.ts" \
  packages apps scripts examples docs --glob '*.ts' --glob '*.tsx' --glob '*.md'
rg -n "setAuditSink|processAdminMutationUntilCompletion|crdtAuditSink" \
  packages apps --glob '*.ts'
git status --short
```

Expected: no active old path, setter, old admin method, or route audit plumbing remains. Only
historical plans may contain predecessor paths. The tracked worktree is clean after the final
candidate commit.

- [ ] **Step 7: Request final code review**

Use `superpowers:requesting-code-review` against the exact PR B head. Require review of:

- public export identity;
- API and WebSocket behavior;
- command/result/persisted shape compatibility;
- AppInbox transaction/retry and guarded-write order;
- audit no-sink and configured-sink behavior;
- construction completeness and callback timing;
- touched-file closure and affected legacy;
- cold navigation trace;
- benchmark and black-box evidence.

Fix every Critical, Important, and Minor finding or explicitly classify it under the repository's
allowed escalation conditions. Rerun the smallest affected checks, then the final impacted gates.

- [ ] **Step 8: Publish PR B and stop at merge**

Use `rallar-repo:publishing-plan-progress`. Push the feature branch, create/update the draft PR with
Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up. Run:

```bash
npm run pr:delivery -- status
npm run pr:delivery -- ready
```

Run `ready` once at handoff. When GitHub reports the PR merged, stop. Do not update this plan, write a
receipt, close a catalog entry, rebase, or create a post-merge governance commit.

---

## Final Acceptance Checklist

- [ ] One canonical `rallar-system/crdt` feature boundary owns realtime, inbox, mutation, and
      persistence.
- [ ] API-v1 owns only API session/document authorization, CRDT construction, HTTP routes, admin
      request/result translation, and composition.
- [ ] The complete WebSocket and HTTP mutation paths use one AppInbox service and one mutation
      decision implementation.
- [ ] The mutation attempt visibly executes read, pure compute, pure validate, and transaction-bound
      write; AppInbox owns retry and transaction lifecycle.
- [ ] Package-root CRDT exports have the same names and runtime identities; repository types are
      narrowed only after every in-repository consumer migrates in the same slice.
- [ ] REST, WebSocket, queue, command/result, persisted, policy, retry, receipt, and final outbox
      contracts remain compatible.
- [ ] Default production registers no audit handler without a sink; configured audit delivery is
      post-commit and retryable; durable audit APP outbox work remains authoritative.
- [ ] Every CRDT final outbox insert is insert-only; an identical or differing collision rolls the
      complete authoritative mutation transaction back and never loads a winner.
- [ ] All task/correction CRDT tests moved to behavior-named mirrored paths with no lost assertion.
- [ ] Every old CRDT source path and unapproved compatibility path is absent from active consumers.
- [ ] Every changed human-authored file was reviewed and remediated in full.
- [ ] Every changed support file recursively reached closure.
- [ ] Independent untouched code remained outside closure.
- [ ] Every affected legacy candidate is removed, minimized-boundary, resolved, or explicitly
      approved and registered.
- [ ] Focused tests, shared-server typecheck, API Deno check, live Postgres, CRDT black-box,
      medium-scale, required state-write comparison, style, structure, formatting, legacy, and cold
      navigation evidence are passed or truthfully reported skipped.
- [ ] Every actual bug has regression coverage and every unresolved confirmed weakness has an
      accurate issue owner.
- [ ] Issue #265 remains open and accurately owns the unchanged append full-history read/decode
      performance follow-up unless separately measured and resolved outside this plan's scope.
