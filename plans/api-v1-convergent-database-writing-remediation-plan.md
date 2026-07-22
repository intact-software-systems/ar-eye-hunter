# API-v1 AppInbox Transactional Mutation Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also use the repo-local `rallar-platform`, `rallar-realtime`, `rallar-code-writing`, and `rallar-testing` skills for every task that touches their surfaces, and use `superpowers:writing-skills` for Task 13 skill edits and verification.

**Goal:** Make AppInbox the mandatory boundary for every incoming api-v1 database mutation and atomically commit each winning service write, its events and receipts, its final `APP_OUTBOX`/`WS_OUTBOX` rows, and its AppInbox result/completion through one AppInbox-owned PostgreSQL transaction.

**Architecture:** Preserve the convergent CAS, guarded-batch, mandatory-contract, black-box, and performance work already present on `codex/api-v1-convergent-db-writes`. Move transaction creation and retry ownership out of domain services and into AppInbox/QueueBox. Every service remains visibly `read -> compute -> validate -> write`; `write(transaction, computed)` uses transaction-bound repositories, including `ResourceInboxRepository`, and never starts a transaction or retries. Remove the intermediate state-mutation outbox and resolve all external effects only after the final `APP_OUTBOX` or `WS_OUTBOX` row commits.

**Tech Stack:** TypeScript, Deno, Node/npm workspaces, Vitest, PostgreSQL, PGlite, Hono, QueueBox/ResourceInbox, AL WebSocket messages, YAML/OpenAPI, Rallar black-box recipes.

**Approved design:** `docs/superpowers/specs/2026-07-22-api-v1-app-inbox-transactional-mutations-design.md`

## Global Constraints

- Execute this plan on the existing `codex/api-v1-convergent-db-writes` implementation branch after bringing the approved design and this replacement plan into its isolated worktree. Preserve its compatible CAS, guarded-batch, mandatory-field, black-box, and performance commits; do not restart from `main`.
- AppInbox is mandatory for incoming HTTP and WebSocket commands that can mutate database state, including authentication/session/ticket issuance or consumption, CRDT updates and administration, and operational mutation routes—not only client, group, and topology state. `WS_INBOX` may remain the socket ingress transport, but its mutating handlers must enqueue deterministic `APP_INBOX` commands.
- Every targeted service exposes visible verb-based operations in the order `read -> compute -> validate -> write`. Computed persistence data is named `computed` or by a domain-specific computed noun. Never call it a plan in code, types, parameters, variables, metrics, or architecture documentation.
- `read`, `compute`, and `validate` run without an open write transaction. `compute` and `validate` are deterministic and have no repository, clock, randomness, identifier generation, environment, publication, or transaction access.
- AppInbox creates one short PostgreSQL transaction. Every service `write(transaction, computed)` receives that exact `PSqlTransactionSql` and must not call `begin`, commit, roll back, sleep, retry, send, publish, resolve live WS recipients, or perform a domain reread.
- A DB-mutating `APP_OUTBOX` consumer follows the same rule: its queue handler creates the transaction, passes it to service `write`, inserts downstream outbox rows, and reservation-fences completion in that transaction. A `WS_OUTBOX` network send cannot be transactionally coupled to the socket and remains idempotent at-least-once delivery.
- The first authoritative statement in `write` is a conditional insert, expected-revision update, or expected-revision delete. A zero-row result throws the typed optimistic conflict. Dependent rows, events, receipts, direct outbox entries, AppInbox result, and AppInbox completion follow and roll back together on any failure.
- Services write final durable `APP_OUTBOX` and `WS_OUTBOX` entries directly through `ResourceInboxRepository(transaction)`. Do not add another mutation-intent table, namespace, drainer, or `StateMutationOutboxWork` replacement.
- Queue wake-up, topology computation, WS recipient resolution, socket delivery, and all other external work occur after commit. Polling remains the recovery path if the wake is lost.
- AppInbox/ResourceInbox owns retrying. There are 20 total processing attempts: attempt 1 is immediate; delays after attempts 1–5 are `1, 2, 4, 8, 16` ms; delays after attempts 6–10 are `1, 2, 4, 8, 16` seconds; delays after attempts 11–19 are capped at 30 seconds. Apply 20 percent jitter with a one-millisecond minimum for nonzero delays.
- Every retry starts again at `read` and reruns authorization, policy, capacity, lifecycle, idempotency, and invariant validation. Never retry only a stale `write` and never reuse computed data from a losing predecessor.
- A retryable row whose `next_ts` is at least 30 seconds overdue is eligible for the separately measured, rate-limited best-effort fairness lane. The lane never processes before `next_ts` and does not promise strict fairness.
- `FOR UPDATE SKIP LOCKED` is allowed only for short queue claiming. Domain row, table, and advisory locks remain prohibited unless a separate human-approved design documents a measured exception and removal condition.
- Persisted, queued, event, snapshot, receipt, result, and response contracts use mandatory fields by default. Genuine absence uses a discriminated union or required `null`; sparse request, patch, builder, and migration inputs remain separate types.
- Preserve the existing final scale gate: 100 independently authenticated client identities, five shared group aggregates, ten concurrent client lanes, five group/topology lanes, and two api-v1 processes sharing PostgreSQL.
- Follow TDD within every task: add one focused failing behavior test, run it and confirm the expected failure, implement only that behavior, rerun the focused tests, and commit the independently reviewable result.
- Keep generated benchmark and black-box artifacts under `tmp/`; never commit them. Preserve unrelated changes and stage only the files listed by the current task.

---

## Existing Work to Preserve and Rework

The feature branch already supplies valuable work that this plan must retain:

- conditional runtime-state insert/update/delete and guarded batch primitives;
- client, group, topology configuration, topology publication, and RTT CAS logic;
- pure client/group/topology computed types and validators;
- mandatory authoritative contracts and boundary validators;
- two-server convergence recipes and the medium-scale gate;
- state-write performance harnesses and comparison tooling;
- focused conflict, stale-expiry, idempotency, and convergence tests.

The following branch decisions are explicitly rejected and must be replaced:

| Rejected branch behavior | Required replacement |
| --- | --- |
| Services call `runtime.begin(...)` inside `write` | AppInbox/queue handler calls the shared transaction utility and passes `PSqlTransactionSql` into `write` |
| Service-local `[0, 2, 8]` or other inner retry loops | ResourceInbox owns the staged 20-attempt schedule; every retry re-enters the complete service flow |
| `state-mutation:outbox` plus `StateMutationOutboxWork` | Service `write` inserts final deterministic `APP_OUTBOX`/`WS_OUTBOX` rows directly through the transaction-bound repository |
| WS enqueue checks warm live routes before durable insertion | Persist one logical scoped WS message; resolve current recipients only while consuming `WS_OUTBOX` |
| AppInbox result and QueueBox completion commit after the domain mutation | Result and reservation-identity completion commit in the same transaction as the domain mutation and final outbox rows |

## File and Responsibility Map

### New files

- `packages/shared-server/postgres/run-in-transaction.ts`: one verb-based callback utility that exposes the database transaction and relies on PostgreSQL for commit/rollback.
- `packages/shared/queuebox/ResourceInboxRetryPolicy.ts`: mandatory retry configuration, staged delay calculation, deterministic jitter injection, exhaustion decision, and stale-due threshold.
- `packages/tests/shared/resource-inbox-retry-policy.test.ts`: exact attempts 1–20, jitter bounds, exhaustion, and fairness-threshold tests.
- `packages/tests/shared-server/postgres-transaction-boundary.test.ts`: proves repositories built from one transaction commit and roll back together and that service writes do not start nested transactions.
- `packages/tests/shared-server/app-inbox-transaction.test.ts`: proves state, event, receipt, direct outbox rows, result, and completion are atomic and reservation-fenced.
- `packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts`: enumerates HTTP/WS mutation entry points and rejects direct mutating service calls.
- `packages/shared-server/rallar-system/services/AppAuthInboxService.ts` and `auth-state-mutations.ts`: make auth-user, auth-session, logout, and one-time-ticket changes deterministic AppInbox operations without persisting plaintext credentials.
- `packages/shared-server/rallar-system/services/AppCrdtInboxService.ts` and `crdt-mutations.ts`: make WS CRDT append and HTTP CRDT administrative changes transaction-receiving AppInbox operations.
- `packages/shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts`: processes bounded maintenance pages as APP_OUTBOX work with transaction-fenced completion.
- `packages/tests/shared-server/direct-resource-outbox.test.ts`: deterministic immutable insert, identical replay, collision corruption, no-live-route WS persistence, and post-commit wake tests.
- `packages/shared-server/rallar-system/services/mutation-command-identity.ts`: canonical JSON/hash helpers retained after deleting the intermediate outbox repository.

### Existing files with changed responsibility

- `packages/shared-server/postgres/PostgresSqlClient.ts`: remains the source of `PSqlSql` and `PSqlTransactionSql`.
- `packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts`: adds transaction-safe immutable insert-or-match, reservation-fenced completion, and stale-due reservation methods; methods never start a transaction when constructed with a transaction.
- `packages/shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts`: writes results through the received transaction.
- `packages/shared-server/postgres/queuebox/PSqlQueueBox.ts`: accepts an exact delay in milliseconds rather than deriving `2^attempts` from a `Temporal.TimeUnit`.
- `packages/shared/queuebox/QueueBoxTypes.ts`, `DequeueController.ts`, and `DequeueResourceEntryController.ts`: carry retry policy/decision data, stop automatic AppInbox processing after attempt 20, and add the fairness reservator.
- `packages/shared/queuebox/IndexedDbQueueBox.ts`: preserves interface parity for exact millisecond retry delays.
- `packages/shared-server/rallar-system/services/AppInboxService.ts`: owns the successful/terminal result transaction and classifies retryable failures without an inner loop.
- `packages/shared-server/rallar-system/services/AppClientInboxService.ts` and `AppGroupInboxService.ts`: perform visible phase orchestration and pass the AppInbox transaction into service `write`.
- `packages/shared-server/rallar-system/services/client-state-service.ts`, `group-state-service.ts`, `group-state-guarded-batch.ts`, `group-topology-management-service.ts`, `GroupPresenceSummaryWork.ts`, `RtcTopologyOutboxWork.ts`, and `rtc-rtt-mutation-service.ts`: accept transactions in `write`, remove inner retries, and insert final ResourceInbox outbox rows.
- `packages/shared-server/rallar-system/services/client-state-mutations.ts`, `group-state-mutations.ts`, `group-topology-config-mutations.ts`, and `rtc-topology-mutations.ts`: replace intermediate outbox intents with fully populated computed `ResourceEntry` effects or mandatory data from which `write` constructs them without nondeterminism.
- `packages/shared-server/rallar-system/services/auth-login-service.ts`, `AuthSessionRepository.ts`, and `AuthUserRepository.ts`: replace username/ticket advisory locks and implicit retrying with conditional insert/delete operations called by `AppAuthInboxService.write(transaction, computed)`.
- `packages/shared-server/crdt/RallarCrdtServer.ts`, `packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts`, and CRDT admin services/routes: split durable CRDT changes into `read -> compute -> validate -> write(transaction, computed)`, replace document-row locking with revision predicates, and persist response/fanout work as direct WS_OUTBOX rows.
- `packages/shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts` and `PSqlOutboundAdmissionBackend.ts`: replace advisory admission locks with conditional insert/update/delete fencing; QueueBox row claiming remains the only locking exception.
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts` and `PSqlAdminOperationsPruner`: route database-mutating operational commands through AppInbox and execute pruning as bounded transaction-receiving APP_OUTBOX work; process-local metric reset and read-only POST queries remain direct.
- `packages/shared-server/rallar-system/state-sync-publisher.ts` and `packages/shared/services/WsQueueBoxServerService.ts`: persist logical WS audience before live-route resolution and resolve recipients during outbox consumption.
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts` and `apps/api-v1/src/middleware.ts`: inject the SQL database into AppInbox and remove state-mutation outbox wiring.
- `apps/api-v1/src/routes/config-route.ts`, `client-state-routes.ts`, `group-state-routes.ts`, `graph-topology-routes.ts`, `crdt-admin-routes.ts`, `admin-operations-routes.ts`, and `ws-routes.ts`: send every database mutation through AppInbox while leaving proven read-only handlers direct.
- `packages/shared-server/rallar-system/ws-system-topics.ts`, `ws-lifecycle-service.ts`, and `presence-expiry-reconciliation-service.ts`: convert DB-mutating WS/internal triggers into AppInbox or queue commands.
- `scripts/perf/api-v1-state-write-concurrency-bench.ts` and `compare-api-v1-state-write-results.mjs`: measure direct `resource_inbox` effects and ResourceInbox-owned attempts instead of intermediate intents and service-local attempts.
- `AGENTS.md`, `.agents/skills/rallar-platform/SKILL.md`, `.agents/skills/rallar-realtime/SKILL.md`, `.agents/skills/rallar-code-writing/SKILL.md`, `.agents/skills/rallar-testing/SKILL.md`, `packages/shared-server/architecture.md`, `packages/shared-server/rallar-server-repositories.md`, `packages/shared-server/rallar-server-repositories-improvements.md`, `docs/rallar-api-reference.md`, and `docs/rallar-convergent-state-and-rtc-topology.md`: encode the approved architecture and remove stale precedent.

---

### Task 1: Shared Transaction and ResourceInbox Atomic-Write Foundation

**Files:**
- Create: `packages/shared-server/postgres/run-in-transaction.ts`
- Create: `packages/tests/shared-server/postgres-transaction-boundary.test.ts`
- Modify: `packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts`
- Modify: `packages/shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts`
- Modify: `packages/shared-server/postgres/PostgresSqlClient.ts`
- Modify: `packages/shared-server/mod.ts`
- Test: `packages/tests/shared/resource-inbox-repository.test.ts`

**Interfaces:**
- Produces: `runInTransaction<T>(database: PSqlSql, write: (transaction: PSqlTransactionSql) => Promise<T>): Promise<T>`.
- Produces: `ResourceInboxRepository.writeIfAbsentOrMatch(entry: ResourceEntry): Promise<'inserted' | 'matched'>`.
- Produces: `ResourceInboxRepository.finishReserved(key: Key, expectedAttempts: number, status: EntityStatus.COMPLETED | EntityStatus.FAILED, completedAt: Date): Promise<boolean>`.
- Consumes: existing `PSqlSql`, `PSqlTransactionSql`, `ResourceEntry`, and composite ResourceInbox key.

- [ ] **Step 1: Write failing transaction-boundary tests**

Add tests that construct runtime-state, event, ResourceInbox, and result repositories from the same fake transaction marker. Assert one `begin`, one transaction identity, successful atomic persistence, and full rollback when the final completion write throws.

```ts
it('binds every write repository to one database transaction', async () => {
    const observed: unknown[] = [];
    await runInTransaction(database, async (transaction) => {
        observed.push(transaction);
        await new PSqlRuntimeStateRepository(transaction).insertIfAbsent(
            'transaction-test',
            'aggregate-1',
            JSON.stringify({ state: 'accepted' }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(outboxEntry);
        await new ResourceInboxResultsRepository(transaction).replace(resultEntry);
    });
    expect(new Set(observed).size).toBe(1);
    expect(database.beginCalls).toBe(1);
});

it('rolls state and outbox back when completion fails', async () => {
    await expect(runMutation({ failCompletion: true })).rejects.toThrow('completion-failed');
    expect(await readState()).toBeUndefined();
    expect(await readOutbox()).toBeUndefined();
    expect(await readResult()).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm the missing APIs fail**

Run:

```bash
npx vitest run packages/tests/shared-server/postgres-transaction-boundary.test.ts packages/tests/shared/resource-inbox-repository.test.ts
```

Expected: FAIL because `run-in-transaction.ts`, `writeIfAbsentOrMatch`, and `finishReserved` do not exist.

- [ ] **Step 3: Add the explicit transaction utility**

Implement exactly one transaction wrapper; do not add decorators, proxies, service lookup, retries, or domain logic.

```ts
import type { PSqlSql, PSqlTransactionSql } from './PostgresSqlClient.ts';

export async function runInTransaction<T>(
    database: PSqlSql,
    write: (transaction: PSqlTransactionSql) => Promise<T>,
): Promise<T> {
    return await database.begin(write);
}
```

- [ ] **Step 4: Add immutable outbox insertion and reservation-fenced completion**

Implement `writeIfAbsentOrMatch` with `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. If the insert loses, read the existing row in the same transaction and compare immutable identity/content: composite key, queue type, resource JSON, creator, creation timestamp, and expiry. Do not require the existing operational status, attempts, reservation timestamps, end timestamp, or `next_ts` to equal the new entry because a matching outbox row may already have advanced through delivery. Return `matched` only when immutable content is identical and the existing lifecycle is valid; otherwise throw `ResourceInboxInvariantCorruptionError`.

Implement terminal reservation finishing as one conditional statement. Bind `${status}` only after validating it is `COMPLETED` or `FAILED`:

```sql
update resource_inbox
set ri_status = ${status}, end_ts = ${completedAt}, next_ts = null
where ri_topic_id = ${key.topicId}
  and ri_resource_id = ${key.resourceId}
  and fk_ext_bank_id = ${key.contextId}
  and ri_status = 'RESERVED'
  and ri_attempts = ${expectedAttempts}
  and expire_ts > now()
returning ri_row_id
```

Return `false` for zero rows; callers treat it as a retryable lost-reservation conflict.

- [ ] **Step 5: Run focused repository and transaction tests**

Run:

```bash
npx vitest run packages/tests/shared-server/postgres-transaction-boundary.test.ts packages/tests/shared/resource-inbox-repository.test.ts packages/tests/shared/resource-inbox-start-processing.test.ts
```

Expected: PASS with identical replay accepted, different-content collision rejected, one transaction observed, and rollback proven.

- [ ] **Step 6: Commit the foundation**

```bash
git add packages/shared-server/postgres/run-in-transaction.ts packages/shared-server/postgres/PostgresSqlClient.ts packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts packages/shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts packages/shared-server/mod.ts packages/tests/shared-server/postgres-transaction-boundary.test.ts packages/tests/shared/resource-inbox-repository.test.ts
git commit -m "feat: add transaction-bound resource inbox writes"
```

---

### Task 2: Staged ResourceInbox Retry Policy and Fairness Lane

**Files:**
- Create: `packages/shared/queuebox/ResourceInboxRetryPolicy.ts`
- Create: `packages/tests/shared/resource-inbox-retry-policy.test.ts`
- Modify: `packages/shared/queuebox/QueueBoxTypes.ts`
- Modify: `packages/shared/queuebox/DequeueController.ts`
- Modify: `packages/shared/queuebox/DequeueResourceEntryController.ts`
- Modify: `packages/shared/queuebox/IndexedDbQueueBox.ts`
- Modify: `packages/shared-server/postgres/queuebox/PSqlQueueBox.ts`
- Modify: `packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts`
- Modify: `apps/api-v1/src/middleware-resilience.ts`
- Modify: `scripts/perf/seed-perf-db-sparse-queue.sql`
- Test: `packages/tests/shared/resource-inbox-start-processing.test.ts`
- Test: `packages/tests/shared/resource-inbox-repository.test.ts`
- Test: `packages/tests/shared/queue.test.ts`

**Interfaces:**
- Produces: `DEFAULT_RESOURCE_INBOX_RETRY_POLICY` with mandatory fields `maxAttempts: 20`, `jitterRatio: 0.2`, `maxDelayMs: 30_000`, and `staleDueThresholdMs: 30_000`.
- Produces: `retryAfterAttempt(policy, attempts, jitterUnit): { status: 'retry'; delayMs: number } | { status: 'failed'; delayMs: null }`.
- Produces: `reserveOverdueRetryEntries(types, overdueBeforeEpochMs, maxToReserve)`.
- Consumes: Task 1 transaction-safe ResourceInbox methods.

- [ ] **Step 1: Write exact schedule, exhaustion, and jitter tests**

```ts
const expected = [1, 2, 4, 8, 16, 1_000, 2_000, 4_000, 8_000, 16_000,
    30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

it('schedules attempts two through twenty exactly', () => {
    expect(expected.map((_, index) =>
        retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, index + 1, 0.5)
    )).toEqual(expected.map((delayMs) => ({ status: 'retry', delayMs })));
    expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 20, 0.5))
        .toEqual({ status: 'failed', delayMs: null });
});

it('never jitters a nonzero delay below one millisecond', () => {
    expect(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, 1, 0).delayMs).toBe(1);
});
```

Add repository tests proving ordinary retry reservation requires `next_ts <= now`, the fairness lane requires `next_ts <= now - 30_000`, both use skip-locked claiming, and neither selects expired or `FAILED` rows.

- [ ] **Step 2: Run tests and confirm the old seconds exponent fails**

Run:

```bash
npx vitest run packages/tests/shared/resource-inbox-retry-policy.test.ts packages/tests/shared/resource-inbox-start-processing.test.ts packages/tests/shared/resource-inbox-repository.test.ts
```

Expected: FAIL because retry timing is still a `Temporal.TimeUnit`, first failure schedules two seconds, and the fairness reservator is absent.

- [ ] **Step 3: Implement the mandatory retry policy**

```ts
export type ResourceInboxRetryPolicy = Readonly<{
    maxAttempts: number;
    delaysAfterAttemptMs: readonly number[];
    maxDelayMs: number;
    jitterRatio: number;
    staleDueThresholdMs: number;
}>;

export const DEFAULT_RESOURCE_INBOX_RETRY_POLICY: ResourceInboxRetryPolicy = {
    maxAttempts: 20,
    delaysAfterAttemptMs: [1, 2, 4, 8, 16, 1_000, 2_000, 4_000, 8_000, 16_000],
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    staleDueThresholdMs: 30_000,
};
```

`retryAfterAttempt` returns `failed` when `attempts >= maxAttempts`. For a retry, choose the indexed delay or the cap, multiply by `1 - jitterRatio + (2 * jitterRatio * jitterUnit)`, round, and clamp nonzero values to at least one millisecond.

- [ ] **Step 4: Pass exact millisecond delays through QueueBox**

Replace `RETRY_EXPONENTIAL_BACKOFF_STEPS` and `PSqlQueueBox.toBackoff(...)` with the policy result. Change `releaseEntries` to receive the exact delay for each entry and persist `next_ts = now + delayMs`. Preserve the separate failed status but do not register `FAILED` as an automatic AppInbox retry lane.

```ts
const decision = retryAfterAttempt(retryPolicy, failure.value.dequeueAudit.attempts, jitter());
await repository.releaseEntries(
    [failure.value],
    decision.status === 'retry' ? EntityStatus.RETRY : EntityStatus.FAILED,
    decision.delayMs,
);
```

- [ ] **Step 5: Add the separately rate-limited fairness reservator**

Add a repository query selecting only `RETRY` rows whose `next_ts` is at least `staleDueThresholdMs` overdue. Use the existing runnable index, `FOR UPDATE SKIP LOCKED`, bounded batch size, and a distinct `Reservator.FAIRNESS` enum value. Record `dueAgeMs`, attempt, type, and selection lane.

```sql
select *
from resource_inbox
where ri_type_id in ${typeIds}
  and ri_status = 'RETRY'
  and expire_ts > now()
  and next_ts <= ${new Date(nowEpochMs - policy.staleDueThresholdMs)}
order by next_ts asc, ri_row_id asc
for update skip locked
limit ${maxToReserve}
```

Extend `scripts/perf/seed-perf-db-sparse-queue.sql` with a sparse `RETRY` fixture and this exact fairness predicate under `EXPLAIN (ANALYZE, BUFFERS)`. Verify that PostgreSQL uses `resource_inbox_runnable_ix` without a broad sequential scan. Add a focused index migration only if the measured EXPLAIN output proves the existing index insufficient; do not add a speculative overlapping index.

- [ ] **Step 6: Run focused queue tests**

Run:

```bash
npx vitest run packages/tests/shared/resource-inbox-retry-policy.test.ts packages/tests/shared/resource-inbox-start-processing.test.ts packages/tests/shared/resource-inbox-repository.test.ts packages/tests/shared/queue.test.ts
```

Expected: PASS; attempt 1 failure schedules 1 ms, attempt 20 becomes failed, overdue retry rows are recoverable only through the fairness lane, and pre-due rows are never selected.

With local PostgreSQL available, also run:

```bash
npm run db:up
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:migrate
mkdir -p tmp/perf/results
docker compose exec -T postgres psql -U app -d appdb < scripts/perf/seed-perf-db-sparse-queue.sql > tmp/perf/results/postgres-explain-sparse-queue.txt
rg -n "resource_inbox_runnable_ix|Seq Scan" tmp/perf/results/postgres-explain-sparse-queue.txt
```

Expected: the fairness query is present, uses `resource_inbox_runnable_ix`, and has no broad `Seq Scan` over `resource_inbox`. Record this as PostgreSQL evidence; unit or PGlite tests alone do not satisfy the index check.

- [ ] **Step 7: Commit retry and fairness behavior**

```bash
git add packages/shared/queuebox/ResourceInboxRetryPolicy.ts packages/shared/queuebox/QueueBoxTypes.ts packages/shared/queuebox/DequeueController.ts packages/shared/queuebox/DequeueResourceEntryController.ts packages/shared/queuebox/IndexedDbQueueBox.ts packages/shared-server/postgres/queuebox/PSqlQueueBox.ts packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts apps/api-v1/src/middleware-resilience.ts scripts/perf/seed-perf-db-sparse-queue.sql packages/tests/shared/resource-inbox-retry-policy.test.ts packages/tests/shared/resource-inbox-start-processing.test.ts packages/tests/shared/resource-inbox-repository.test.ts packages/tests/shared/queue.test.ts
git commit -m "feat: stage resource inbox retries and fairness"
```

---

### Task 3: AppInbox-Owned Atomic Result and Completion Transaction

**Files:**
- Create: `packages/tests/shared-server/app-inbox-transaction.test.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/AppClientInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `apps/api-v1/src/middleware.ts`
- Modify: `packages/shared/queuebox/DequeueResourceEntryController.ts`
- Test: `packages/tests/shared-server/app-inbox-service.test.ts`
- Test: `packages/tests/shared-server/app-client-inbox-service.test.ts`
- Test: `packages/tests/shared-server/group-app-inbox-authority.test.ts`

**Interfaces:**
- Consumes: Task 1 `runInTransaction`, `writeIfAbsentOrMatch`, and `finishReserved`.
- Consumes: Task 2 retry classification and schedule.
- Produces: `AppInboxService.writeMutation(context, write): Promise<Result>` for subclasses to call after `read`, `compute`, and `validate`.
- Produces: `AppInboxService.writeTerminalFailure(context, error): Promise<void>` using the same transaction utility for result plus failed completion.

- [ ] **Step 1: Write failing atomicity and reservation-fencing tests**

Cover a successful handler, dependent write failure, outbox insertion failure, result failure, stale reservation completion, terminal policy denial, and retryable CAS conflict. Use the existing timing sink to assert `read`, `compute`, and `validate` run without an open transaction, while transaction and `write` timing identify the same winning attempt. Assert queue age, due age, attempt, selected lane, retry classification, and retry exhaustion are recorded with no computed-data field named `plan`.

```ts
it('commits mutation, outbox, result, and completion together', async () => {
    const result = await service.processEntryUntilCompletion(command);
    expect(result).toEqual(receipt);
    expect(await readMutation()).toEqual(expectedState);
    expect(await readOutboxEntries()).toEqual(expectedOutbox);
    expect(await readInboxResult()).toEqual(receipt);
    expect((await readInboxEntry()).status).toBe(EntityStatus.COMPLETED);
});

it('rolls every successful write back when reservation ownership changed', async () => {
    reclaimReservationBeforeCommit();
    await expect(process()).rejects.toMatchObject({ code: 'app-inbox-reservation-conflict' });
    expect(await readMutation()).toBeUndefined();
    expect(await readOutboxEntries()).toEqual([]);
});
```

- [ ] **Step 2: Run tests and confirm current three-commit behavior fails**

Run:

```bash
npx vitest run packages/tests/shared-server/app-inbox-transaction.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/group-app-inbox-authority.test.ts
```

Expected: FAIL because the handler action, `resource_inbox_results.replace`, and QueueBox success release currently commit independently.

- [ ] **Step 3: Inject the database and add the AppInbox write operation**

Pass `PSqlSql` into AppInbox construction. Add one protected operation that uses the Task 1 utility and exact reservation attempt.

```ts
protected async writeMutation<R>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<R>,
): Promise<R> {
    return await runInTransaction(this.database, async (transaction) => {
        const result = await write(transaction);
        await new ResourceInboxResultsRepository(transaction).replace(
            toResourceEntryWithUpdatedResource(context.entry, EntityStatus.COMPLETED, result),
        );
        const completed = await new ResourceInboxRepository(transaction).finishReserved(
            context.entry.key,
            context.entry.dequeueAudit.attempts,
            EntityStatus.COMPLETED,
            new Date(this.now()),
        );
        if (!completed) throw new AppInboxReservationConflictError(context.entry.key);
        return result;
    });
}
```

- [ ] **Step 4: Make terminal results atomic and retryable failures result-free**

Terminal authorization, policy, malformed-command, invariant, and lifecycle errors write the failed result and conditionally finish the reservation in one transaction. Retryable errors write neither result nor terminal completion; rethrow them for Task 2 scheduling.

```ts
const terminal = toTerminalAppInboxError(error);
if (terminal === undefined) throw error;
await this.writeTerminalFailure(context, terminal);
```

- [ ] **Step 5: Persist retry exhaustion as one failed result transaction**

Add an AppInbox-specific exhaustion callback to the dequeue controller. When `retryAfterAttempt` returns `failed`, write a mandatory `app-inbox-retry-exhausted` result and call `finishReserved(..., EntityStatus.FAILED, ...)` in one `runInTransaction` callback. The result contains command identity, exactly 20 attempts, last error code/message, queue age, and exhausted timestamp. Do not automatically reserve this `FAILED` AppInbox row again; administrative replay must create a new reservation attempt explicitly.

```ts
await runInTransaction(database, async (transaction) => {
    await new ResourceInboxResultsRepository(transaction).replace(exhaustedResult);
    const finished = await new ResourceInboxRepository(transaction).finishReserved(
        entry.key,
        20,
        EntityStatus.FAILED,
        new Date(now()),
    );
    if (!finished) throw new AppInboxReservationConflictError(entry.key);
});
```

- [ ] **Step 6: Make the generic success releaser idempotent for already completed AppInbox rows**

When the callback committed a row as `COMPLETED`, the outer QueueBox release sees that exact terminal row and returns success without another update. A different attempt/status is not idempotent and must surface a reservation conflict.

```ts
if (current.status === EntityStatus.COMPLETED &&
    current.dequeueAudit.attempts === reserved.dequeueAudit.attempts) {
    return current;
}
throw new QueueReservationConflictError(reserved.key);
```

- [ ] **Step 7: Run focused AppInbox tests**

Run:

```bash
npx vitest run packages/tests/shared-server/app-inbox-transaction.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/group-app-inbox-authority.test.ts
```

Expected: PASS with one successful mutation transaction, complete rollback on every injected failure, no result written for retryable conflicts before attempt 20, and one durable failed result/status at exhaustion.

- [ ] **Step 8: Commit AppInbox transaction ownership**

```bash
git add packages/shared-server/rallar-system/services/AppInboxService.ts packages/shared-server/rallar-system/services/AppClientInboxService.ts packages/shared-server/rallar-system/services/AppGroupInboxService.ts packages/shared-server/rallar-system/middleware/RallarMiddleware.ts apps/api-v1/src/middleware.ts packages/shared/queuebox/DequeueResourceEntryController.ts packages/tests/shared-server/app-inbox-transaction.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/group-app-inbox-authority.test.ts
git commit -m "feat: let app inbox own mutation commits"
```

---

### Task 4: Direct Transactional APP_OUTBOX and Logical WS_OUTBOX Writes

**Files:**
- Create: `packages/tests/shared-server/direct-resource-outbox.test.ts`
- Modify: `packages/shared-server/rallar-system/state-sync-publisher.ts`
- Modify: `packages/shared-server/rallar-system/state-sync-routing.ts`
- Modify: `packages/shared/services/WsQueueBoxServerService.ts`
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`
- Modify: `packages/shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts`
- Modify: `packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts`
- Test: `packages/tests/shared-server/state-sync-publisher.test.ts`
- Test: `packages/tests/shared-server/state-sync-routing.test.ts`
- Test: `packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts`
- Test: `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`

**Interfaces:**
- Produces: `ComputedClientStateSync` and `ComputedGroupStateSync`, mandatory data-only inputs containing command ID, aggregate reference, accepted causal revision, event/snapshot payload, audience, created/expiry timestamps, and effect kinds.
- Produces: pure `computeClientStateSyncEntries(computed: ComputedClientStateSync, senderId: string)` and `computeGroupStateSyncEntries(computed: ComputedGroupStateSync, senderId: string)` functions returning fully populated immutable `WS_OUTBOX` `ResourceEntry` values.
- Produces: `ComputedRtcTopologyOutbox` plus pure `computeRtcTopologyEntry(computed: ComputedRtcTopologyOutbox, senderId: string)` returning a fully populated immutable `APP_OUTBOX` entry for an accepted causal revision.
- Consumes: Task 1 `ResourceInboxRepository.writeIfAbsentOrMatch` directly from service writes.
- Changes: `WsQueueBoxServerService` resolves recipients while consuming persisted logical messages, not before insertion.

- [ ] **Step 1: Write failing direct-outbox tests**

```ts
it('persists logical websocket work without a live local route', async () => {
    const entries = computeGroupStateSyncEntries(groupComputed, senderId);
    await runInTransaction(database, async (transaction) => {
        const repository = new ResourceInboxRepository(transaction);
        for (const entry of entries) await repository.writeIfAbsentOrMatch(entry);
    });
    expect(entries.every((entry) => entry.typeId === EnqueuedType.WS_OUTBOX)).toBe(true);
    expect(await readPersisted(entries[0].key)).toBeDefined();
});

it('rejects equal outbox identity with different content', async () => {
    await write(first);
    await expect(write({ ...first, resource: differentJson }))
        .rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
});
```

Also prove no socket callback fires before commit, a wake failure does not remove the row, and the existing WS worker resolves recipients after commit.

- [ ] **Step 2: Run tests and confirm live-route enqueue behavior fails**

Run:

```bash
npx vitest run packages/tests/shared-server/direct-resource-outbox.test.ts packages/tests/shared-server/state-sync-publisher.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts
```

Expected: FAIL because state sync calls `enqueueOutboxIfAbsent`, which returns `no-route` before persisting, and topology enqueue starts its own QueueBox transaction.

- [ ] **Step 3: Separate pure message/entry computation from delivery**

Create deterministic message IDs from command identity, effect kind, payload kind, and causal revision. Return one logical broadcast ResourceEntry with mandatory scoped audience and payload; do not inspect `JsonWebSocketServer` or recipient stores.

```ts
export function computeGroupStateSyncEntries(
    computed: ComputedGroupStateSync,
    senderId: string,
): readonly ResourceEntry[] {
    return computed.effects.map((effect) =>
        QueueBoxUtilities.toResourceEntryFromMsg(
            toLogicalGroupStateMessage(computed, effect, senderId),
            EnqueuedType.WS_OUTBOX,
        )
    );
}
```

- [ ] **Step 4: Resolve WS recipients during dequeue**

Remove the pre-enqueue `resolveRecipients(message).length === 0` short circuit for logical durable messages. During WS_OUTBOX consumption, resolve current recipients and record `sent`, `no-current-recipient`, or retryable transport failure. `no-current-recipient` is a delivery outcome; the persisted row remains the atomic proof.

```ts
const recipients = this.resolveRecipients(message);
if (recipients.length === 0) {
    return { status: 'no-current-recipient', messageId: message.id.msgId };
}
return await this.sendToRecipients(message, recipients);
```

- [ ] **Step 5: Preserve explicit APP_OUTBOX coalescing without an intermediate mutation layer**

Mutation-derived topology work uses immutable per-command/revision entries and `writeIfAbsentOrMatch`. Existing timer/RTT coalescing may retain stable keys, but any update inside a service write must use the received transaction and a conditional generation/status predicate. Never overwrite a reserved generation; insert its deterministic successor instead.

```sql
update resource_inbox
set ri_resource = ${nextResource}, next_ts = ${nextTimestamp}
where ri_topic_id = ${key.topicId}
  and ri_resource_id = ${key.resourceId}
  and fk_ext_bank_id = ${key.contextId}
  and ri_status in ('NEW', 'RETRY')
  and ri_resource = ${expectedResource}
returning *
```

- [ ] **Step 6: Run direct-outbox and routing tests**

Run the command from Step 2 again.

Expected: PASS with durable no-route WS rows, post-commit recipient resolution, immutable identical replay, invariant collision rejection, and no nested QueueBox transaction in service writes.

- [ ] **Step 7: Commit direct outbox behavior**

```bash
git add packages/shared-server/rallar-system/state-sync-publisher.ts packages/shared-server/rallar-system/state-sync-routing.ts packages/shared/services/WsQueueBoxServerService.ts packages/shared/alm/ALOutboundMessageRuntime.ts packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts packages/shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts packages/shared-server/postgres/resource-inbox/ResourceInboxRepository.ts packages/tests/shared-server/direct-resource-outbox.test.ts packages/tests/shared-server/state-sync-publisher.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts
git commit -m "feat: write final resource outbox entries atomically"
```

---

### Task 5: Client Mutation Service Transaction Injection

**Files:**
- Modify: `packages/shared-server/rallar-system/services/client-state-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/client-state-service.ts`
- Modify: `packages/shared-server/rallar-system/repositories/ClientStateRepository.ts`
- Modify: `packages/shared-server/rallar-system/services/AppClientInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/cached-client-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts`
- Test: `packages/tests/shared-server/client-state-concurrency.test.ts`
- Test: `packages/tests/shared-server/client-state-service-idempotency.test.ts`
- Test: `apps/api-v1/test/services/client-state-service.test.ts`
- Test: `packages/tests/shared-server/app-client-inbox-service.test.ts`

**Interfaces:**
- Produces: `ClientStateMutationService.read(command)`, `.compute(command, read)`, `.validate(command, read, computed)`, and `.write(transaction, computed)`.
- `write` returns `ClientMutationReceipt` and writes its deterministic `WS_OUTBOX` entries through `ResourceInboxRepository(transaction)`.
- Consumes: Tasks 3–4 AppInbox transaction operation and computed WS entries.

- [ ] **Step 1: Replace inner-retry expectations with AppInbox retry tests**

Add a test where attempt 1 loses the principal CAS, QueueBox marks the AppInbox row retryable, attempt 2 rereads a changed authorization/lifecycle surface, and only the recomputed successor commits.

```ts
expect(timing.map((event) => event.phase)).toEqual([
    'read', 'compute', 'validate', 'write-conflict',
    'read', 'compute', 'validate', 'write-accepted',
]);
expect(serviceLocalSleeps).toEqual([]);
expect(resourceInboxAttemptCount).toBe(2);
```

Add rollback assertions for principal, instance/session, event, receipt, WS outbox, result, and completion.

- [ ] **Step 2: Run client tests and confirm service-owned transaction/retry failures**

Run:

```bash
npx vitest run packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/services/client-state-service.test.ts
```

Expected: FAIL because `writeClientMutation` calls `runtime.begin`, writes an intermediate intent, and the service owns retry timing.

- [ ] **Step 3: Expose visible client phase operations**

Keep the existing discriminated `ClientMutationCommand`, read, and computed unions. Make the service methods visible with consistent signatures:

```ts
export type ClientMutationComputedPersistedNoOp = Readonly<{
    outcome: 'no-op';
    persistIdempotency: true;
    aggregateRef: ClientPrincipalRef;
    idempotency: ClientMutationIdempotencyRecord;
    receipt: ClientMutationReceipt;
}>;

export type ClientMutationComputedWrite =
    | Extract<ClientMutationComputed, { outcome: 'write' }>
    | ClientMutationComputedPersistedNoOp;

read(command: ClientMutationCommand): Promise<ClientMutationRead>;
compute(command: ClientMutationCommand, read: ClientMutationRead): ClientMutationComputed;
validate(command: ClientMutationCommand, read: ClientMutationRead, computed: ClientMutationComputed): void;
write(transaction: PSqlTransactionSql, computed: ClientMutationComputedWrite): Promise<ClientMutationReceipt>;
```

Split the existing no-op shape into `persistIdempotency: true` with a mandatory idempotency record and `persistIdempotency: false` without one so `requiresClientWrite(computed)` is exhaustively typed. A persisted no-op writes only its conditional receipt in the AppInbox transaction; a normal write also writes state, event, and outbox entries.

All clock, IDs, and hashes are mandatory command facts persisted in APP_INBOX before attempt 1.

- [ ] **Step 4: Make client write transaction-bound and direct-outbox**

Remove `runtime.begin` and the service retry loop. Build `ClientStateRepository`, event repository, and `ResourceInboxRepository` from `transaction`. Keep the principal guard first; then write child state, receipt, event, and every computed WS entry with `writeIfAbsentOrMatch`.

```ts
const repository = repositoryFor(new PSqlRuntimeStateRepository(transaction));
const outbox = new ResourceInboxRepository(transaction);
if (computed.outcome === 'no-op') {
    requireConditionalWrite(await repository.insertIdempotentClientStateWritten(
        computed.aggregateRef,
        computed.idempotency.requestId,
        computed.idempotency,
    ));
    return computed.receipt;
}
requireConditionalWrite(await repository.updatePrincipal(value, expectedRevision));
await writeChildren(repository, computed);
await repository.appendEvent(computed.event);
await repository.insertReceipt(computed.receipt);
for (const entry of computed.outboxEntries) await outbox.writeIfAbsentOrMatch(entry);
return computed.receipt;
```

- [ ] **Step 5: Make AppClientInboxService orchestrate all four phases**

For every client AppInbox type, call `read`, `compute`, `validate`, then Task 3 `writeMutation(context, transaction => service.write(transaction, computed))`. Convert expired-session and authorized WS lifecycle mutations to the same command path; no client mutator may be invoked outside AppInbox.

```ts
const read = await this.clientState.read(command);
const computed = this.clientState.compute(command, read);
this.clientState.validate(command, read, computed);
return await this.writeMutation(context, async (transaction) =>
    requiresClientWrite(computed)
        ? await this.clientState.write(transaction, computed)
        : toClientMutationReceipt(computed)
);
```

- [ ] **Step 6: Run focused client tests**

Run the commands from Step 2 again.

Expected: PASS with no service-local begin/sleep, full reread after conflict, one atomic winning commit, deterministic WS outbox entries, and idempotent duplicate receipts.

- [ ] **Step 7: Commit client conversion**

```bash
git add packages/shared-server/rallar-system/services/client-state-mutations.ts packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/repositories/ClientStateRepository.ts packages/shared-server/rallar-system/services/AppClientInboxService.ts packages/shared-server/rallar-system/services/cached-client-state-service.ts packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts apps/api-v1/test/services/client-state-service.test.ts
git commit -m "refactor: run client writes in app inbox transactions"
```

---

### Task 6: Group, Membership, and Presence Transaction Injection

**Files:**
- Modify: `packages/shared-server/rallar-system/services/group-state-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-mutation-read.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-guarded-batch.ts`
- Modify: `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts`
- Modify: `packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/cached-group-state-service.ts`
- Test: `packages/tests/shared-server/group-state-concurrency.test.ts`
- Test: `packages/tests/shared-server/group-state-service-idempotency.test.ts`
- Test: `packages/tests/shared-server/group-app-inbox-authority.test.ts`
- Test: `apps/api-v1/test/services/group-state-service.test.ts`

**Interfaces:**
- Produces: `GroupStateMutationService.read`, `.compute`, `.validate`, and `.write(transaction, computed)`.
- Changes: `writeGroupMutation(transaction, repositoryFor, computed)` never calls `begin`.
- Produces: a deterministic presence-summary `APP_OUTBOX` entry carrying the accepted group revision and event. `GroupPresenceSummaryWork.write(transaction, computed)` later commits the converged summary and its downstream group-state `WS_OUTBOX` and topology `APP_OUTBOX` entries atomically.

- [ ] **Step 1: Write failing outer-retry and atomic-effect tests**

Cover group creation, metadata, invite/join, membership, governance, ownership transfer, presence connect/heartbeat/disconnect, expiry, and capacity races. For one conflict, change membership authorization before retry and assert the retry is denied rather than reusing the prior computed value.

```ts
expect(attempts).toEqual([
    { attempt: 1, outcome: 'conflict', authorized: true },
    { attempt: 2, outcome: 'denied', authorized: false },
]);
expect(await readGroupEvent(conflictingEventId)).toBeUndefined();
expect(await readOutbox(conflictingCommandId)).toEqual([]);
```

- [ ] **Step 2: Run group tests and confirm inner transaction failures**

Run:

```bash
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/group-app-inbox-authority.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/services/group-state-service.test.ts
```

Expected: FAIL because `writeGroupMutation` calls `runtime.begin`, guarded batch serializes an intermediate outbox intent, and service-local retry owns rebasing.

- [ ] **Step 3: Replace the intermediate intent in group computed values**

Keep mandatory causal fields and receipts. Replace `outbox: StateMutationOutboxRecord` with mandatory `outboxEntries: readonly ResourceEntry[]`. The initial group mutation entry is `APP_OUTBOX` presence-summary work containing the command ID, full `GroupRef`, accepted group revision, event, immutable facts, and effect kind. Do not emit a group snapshot `WS_OUTBOX` row from a predecessor whose presence summary has not converged.

```ts
export type GroupMutationComputedWrite = Extract<
    GroupMutationComputed,
    { outcome: 'write' }
>;

const outboxEntries = [computeGroupPresenceSummaryEntry({
    commandId,
    groupRef,
    acceptedCausalRevision,
    event,
    createdAtEpochMs,
    expireAtEpochMs,
})];
```

- [ ] **Step 4: Pass the transaction into guarded and ordinary group writes**

Change the signature and remove internal `begin`:

```ts
export async function writeGroupMutation(
    transaction: PSqlTransactionSql,
    repositoryFor: (runtime: RuntimeStateOptimisticTransactionalRepositoryLike) => GroupStateRepository,
    computed: GroupMutationComputedWrite,
): Promise<GroupMutationReceipt> {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const repository = repositoryFor(runtime);
    const outbox = new ResourceInboxRepository(transaction);
    // guard first, then dependent state/event/receipt/outbox
}
```

The guarded batch SQL may remain one statement, but its descriptors contain final `resource_inbox` writes or are followed by transaction-bound repository inserts before commit. It must not serialize a `state-mutation:outbox` value.

- [ ] **Step 5: Convert presence summary into direct APP_OUTBOX work**

Group mutations compute immutable `APP_OUTBOX` entries for summary convergence. `GroupPresenceSummaryWork` consumes those entries after commit, performs its own `read -> compute -> validate -> write(transaction, computed)` under the queue handler transaction, and writes the downstream group-state/event `WS_OUTBOX` plus topology-recompute `APP_OUTBOX` rows directly in the same summary transaction. The same transaction reservation-fences completion of the consumed presence-summary APP_OUTBOX entry. The downstream payload uses the newly computed summary and required group/presence causal tuple. Remove the worker's inner retry loop and intermediate intent insertion.

```ts
await runInTransaction(database, async (transaction) => {
    await presenceSummary.write(transaction, computed);
    const inbox = new ResourceInboxRepository(transaction);
    for (const entry of computed.downstreamOutboxEntries) {
        await inbox.writeIfAbsentOrMatch(entry);
    }
    requireFinished(await inbox.finishReserved(
        queueEntry.key,
        queueEntry.dequeueAudit.attempts,
        EntityStatus.COMPLETED,
        new Date(now()),
    ));
});
```

- [ ] **Step 6: Make AppGroupInboxService own all group writes**

Replace `callGroupMutation` service-method dispatch with explicit service phase calls followed by Task 3 `writeMutation`. Keep authentication facts in the durable command and rerun policy from current state on every attempt.

```ts
const read = await this.groupState.read(command);
const computed = this.groupState.compute(command, read);
this.groupState.validate(command, read, computed);
return await this.writeMutation(context, async (transaction) =>
    computed.outcome === 'write'
        ? await this.groupState.write(transaction, computed)
        : toGroupMutationReceipt(computed)
);
```

- [ ] **Step 7: Run focused group/presence tests**

Run the commands from Step 2 plus:

```bash
npx vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts
```

Expected: PASS with independent presence CAS, current-policy retry checks, atomic group/event/receipt/final-outbox writes, and no group service `begin` or sleep.

- [ ] **Step 8: Commit group and presence conversion**

```bash
git add packages/shared-server/rallar-system/services/group-state-mutations.ts packages/shared-server/rallar-system/services/group-state-mutation-read.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/services/group-state-guarded-batch.ts packages/shared-server/rallar-system/repositories/GroupStateRepository.ts packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts packages/shared-server/rallar-system/services/AppGroupInboxService.ts packages/shared-server/rallar-system/services/cached-group-state-service.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/group-app-inbox-authority.test.ts apps/api-v1/test/services/group-state-service.test.ts
git commit -m "refactor: run group writes in app inbox transactions"
```

---

### Task 7: Topology Configuration, Execution, Publication, and RTT Transactions

**Files:**
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/group-topology-config-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts`
- Modify: `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`
- Modify: `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`
- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts`
- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts`
- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts`
- Modify: `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts`
- Modify: `apps/api-v1/src/routes/graph-topology-routes.ts`
- Test: `packages/tests/shared-server/group-topology-management-service.test.ts`
- Test: `packages/tests/shared-server/rtc-topology-mutations.test.ts`
- Test: `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- Test: `apps/api-v1/test/routes/graph-topology-routes.test.ts`

**Interfaces:**
- Adds AppInbox types for config put/delete, override put/delete, explicit reconfigure, and RTT submission.
- Produces transaction-receiving `writeTopologyConfigMutation`, `writeTopologyMutation`, and `writeRttMutation` operations.
- Consumes direct immutable `APP_OUTBOX` and logical `WS_OUTBOX` entries from Task 4.

- [ ] **Step 1: Write failing topology AppInbox and transaction tests**

Assert every mutating graph route submits a deterministic AppInbox command, while GET routes remain direct. Inject config CAS, topology publication CAS, and RTT admission conflicts and prove ResourceInbox rather than the service owns attempts.

```ts
expect(appInboxCommands.map((command) => command.type)).toEqual([
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
]);
expect(directTopologyMutationCalls).toBe(0);
```

- [ ] **Step 2: Run topology tests and confirm direct routes/inner retries fail**

Run:

```bash
npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/rtc-topology-mutations.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts
```

Expected: FAIL because graph mutation routes call topology management directly and topology/RTT write functions start transactions or retry locally.

- [ ] **Step 3: Add complete topology AppInbox commands**

Each command includes mandatory authenticated actor, `GroupRef`, request ID, command hash, captured timestamp, operation kind, and full request payload. Sparse HTTP inputs are normalized before enqueue. AppInbox recomputes authorization and current topology policy on every attempt.

```ts
const read = await topology.read(command);
const computed = topology.compute(command, read);
topology.validate(command, read, computed);
return await this.writeMutation(context, async (transaction) =>
    requiresTopologyWrite(computed)
        ? await topology.write(transaction, computed)
        : toTopologyMutationResult(computed)
);
```

- [ ] **Step 4: Inject transactions into topology write operations**

Use these consistent signatures:

```ts
export type GroupTopologyConfigMutationComputedWrite = Extract<
    GroupTopologyConfigMutationComputed,
    { outcome: 'write' | 'claim' }
>;
export type RtcTopologyMutationComputedWrite = Extract<
    RtcTopologyMutationComputed,
    { outcome: 'write' }
>;
export type RtcRttMutationComputedWrite = Extract<
    RtcRttMutationComputed,
    { outcome: 'write' }
>;

writeTopologyConfigMutation(
    transaction: PSqlTransactionSql,
    computed: GroupTopologyConfigMutationComputedWrite,
): Promise<TopologyConfigMutationReceipt>;

writeTopologyMutation(
    transaction: PSqlTransactionSql,
    computed: RtcTopologyMutationComputedWrite,
): Promise<RtcTopologyMutationReceipt>;

writeRttMutation(
    transaction: PSqlTransactionSql,
    computed: RtcRttMutationComputedWrite,
): Promise<RttMutationReceipt>;
```

Remove all internal `begin` and `[0, 2, 8]` loops. Preserve expected-revision guards, causal comparison, equal-tuple corruption detection, immutable publication identities, receipt-first convergence, and expiry fencing.

For topology and RTT `APP_OUTBOX` consumers, the queue handler owns one transaction containing `write(transaction, computed)`, every downstream queue row, and reservation-fenced completion of the consumed APP_OUTBOX row. A retryable conflict rolls all of it back and returns control to ResourceInbox retry scheduling.

- [ ] **Step 5: Write final topology effects directly**

Config/override commits insert immutable APP_OUTBOX recompute entries. Accepted topology publications insert logical WS_OUTBOX entries in the same transaction. RTT acceptance inserts only the applicable recompute entry. Queue workers wake after commit and may safely observe a newer state; payload causal revisions remain the accepted immutable identity.

```ts
const resourceInbox = new ResourceInboxRepository(transaction);
for (const entry of computed.outboxEntries) {
    await resourceInbox.writeIfAbsentOrMatch(entry);
}
```

- [ ] **Step 6: Route graph mutations through AppInbox**

Replace direct `putConfig`, `deleteConfig`, `putOverride`, `deleteOverride`, and `reconfigureGroupTopology` route calls with authenticated AppInbox submission and durable result waiting. Keep `readTopologyView`, `readConfig`, and `readOverride` direct.

```ts
return c.json(await deps.appGroupInbox.processAuthenticatedEntryUntilCompletion({
    type: AppInboxType.TOPOLOGY_CONFIG_PUT,
    topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
    resourceId: requestId,
    contextId: toScopedGroupContextId(groupRef),
    senderId: actor.principalId,
    data: normalizedCommand,
}));
```

- [ ] **Step 7: Run focused topology tests**

Run the commands from Step 2 again.

Expected: PASS with no route bypass, no inner retry, one transaction for state/receipt/outbox/result/completion, and preserved topology/RTT convergence semantics.

- [ ] **Step 8: Commit topology conversion**

```bash
git add packages/shared-server/rallar-system/services/AppInboxService.ts packages/shared-server/rallar-system/services/AppGroupInboxService.ts packages/shared-server/rallar-system/services/group-topology-config-mutations.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/rtc-topology-mutations.ts packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts packages/shared-server/rallar-system/repositories/RtcRttRepository.ts apps/api-v1/src/routes/graph-topology-routes.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/rtc-topology-mutations.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts apps/api-v1/test/routes/graph-topology-routes.test.ts
git commit -m "refactor: route topology writes through app inbox"
```

---

### Task 8: Authentication, Session, Ticket, and AL Admission Transactions

**Files:**
- Create: `packages/shared-server/rallar-system/services/auth-state-mutations.ts`
- Create: `packages/shared-server/rallar-system/services/AppAuthInboxService.ts`
- Create: `packages/tests/shared-server/app-auth-inbox-service.test.ts`
- Create: `packages/tests/api-v1/psql-outbound-admission-backend.test.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/auth-login-service.ts`
- Modify: `packages/shared-server/rallar-system/repositories/AuthUserRepository.ts`
- Modify: `packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts`
- Modify: `packages/shared-server/http/request-auth-service.ts`
- Modify: `packages/shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts`
- Modify: `packages/shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts`
- Modify: `packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts`
- Modify: `packages/shared-server/runtime-state/RuntimeStateRepository.ts`
- Modify: `packages/shared/alm/ALInboundAdmissionStore.ts`
- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `apps/api-v1/src/middleware.ts`
- Modify: `apps/api-v1/src/routes/config-route.ts`
- Modify: `apps/api-v1/src/repository/login-repository.ts`
- Modify: `apps/api-v1/src/routes/ws-routes.ts`
- Test: `packages/tests/shared-server/auth-login-service.test.ts`
- Test: `packages/tests/shared-server/request-auth-service.test.ts`
- Test: `packages/tests/api-v1/psql-inbound-admission-backend.test.ts`
- Test: `packages/tests/shared-server/runtime-state-conditional-writes.test.ts`
- Test: `apps/api-v1/test/login-repository.test.ts`
- Test: `apps/api-v1/test/config-route-auth-logout.test.ts`
- Test: `apps/api-v1/test/routes/agent-session-ticket-route.test.ts`
- Test: `apps/api-v1/test/request-auth-service.test.ts`
- Test: `apps/api-v1/test/ws-routes.test.ts`

**Interfaces:**
- Adds AppInbox types `AUTH_USER_REGISTER`, `AUTH_SESSION_ISSUE`, `AUTH_SESSION_LOGOUT`, `AUTH_WS_TICKET_ISSUE`, `AUTH_WS_TICKET_CONSUME`, `AUTH_AGENT_SESSION_TICKETS_ISSUE`, and `AUTH_AGENT_SESSION_TICKET_CONSUME`.
- Produces `AuthMutationService.read`, `.compute`, `.validate`, and `.write(transaction, computed)` plus `AppAuthInboxService` orchestration.
- Produces conditional auth repository operations for normalized-username creation and expected-revision ticket consumption; removes username/ticket advisory locks.
- Changes PostgreSQL AL admission to apply typed conditional mutations rather than exposing `lock(key)` callbacks.

- [ ] **Step 1: Write failing auth and AL lock-removal tests**

Cover concurrent same-username registration, duplicate session issuance, logout replay, WS-ticket single consumption, agent-ticket batch atomicity, stale ticket expiry, and two consumers racing one ticket. Assert exactly one conditional winner, deterministic duplicate results, no partial token/session indexes, and full AppInbox result/completion atomicity. Add source/spy assertions that neither auth nor AL admission calls `lockKey`.

```ts
it('allows exactly one ticket consumer without a domain lock', async () => {
    const [left, right] = await Promise.allSettled([
        consumeThroughAppInbox(ticket),
        consumeThroughAppInbox(ticket),
    ]);
    expect([left, right].filter(isFulfilled)).toHaveLength(1);
    expect(await readStoredTicket(ticketDigest)).toBeUndefined();
    expect(observedAdvisoryLocks).toEqual([]);
});
```

- [ ] **Step 2: Run focused tests and confirm direct writes/locks fail**

```bash
npx vitest run packages/tests/shared-server/app-auth-inbox-service.test.ts packages/tests/shared-server/auth-login-service.test.ts packages/tests/shared-server/request-auth-service.test.ts packages/tests/api-v1/psql-inbound-admission-backend.test.ts packages/tests/api-v1/psql-outbound-admission-backend.test.ts
(cd apps/api-v1 && deno test --allow-env --allow-read test/login-repository.test.ts test/config-route-auth-logout.test.ts test/routes/agent-session-ticket-route.test.ts test/request-auth-service.test.ts test/ws-routes.test.ts)
```

Expected: FAIL because registration and ticket consumption open transactions and use advisory locks, while config/WS routes mutate auth repositories directly.

- [ ] **Step 3: Define durable auth commands without plaintext credentials**

Normalize boundary inputs before enqueue. Password verification for login remains a read-only precondition; enqueue `AUTH_SESSION_ISSUE` only after verification. Registration hashes the password with a generated salt before enqueue and persists only the hash parameters plus pre-generated user ID. Hash one-time bearer tickets before enqueue and use the digest as the storage/command key; never place a plaintext password or presented ticket in `resource_inbox`, timing, logs, or result diagnostics.

```ts
export type AuthMutationCommand =
    | Readonly<{ kind: 'register-user'; requestId: string; userId: string; username: string;
        normalizedUsername: string; displayName: string | null; passwordHash: string;
        passwordSalt: string; passwordAlgorithm: 'pbkdf2-sha256'; passwordIterations: number;
        capturedAtEpochMs: number }>
    | Readonly<{ kind: 'issue-session'; requestId: string; session: IssuedAuthSession }>
    | Readonly<{ kind: 'logout-session'; requestId: string; expected: IssuedAuthSession }>
    | Readonly<{ kind: 'issue-ws-ticket'; requestId: string; ticketDigest: string;
        ticket: PersistedWebSocketTicket }>
    | Readonly<{ kind: 'consume-ws-ticket'; requestId: string; ticketDigest: string;
        expectedSessionId: string; capturedAtEpochMs: number }>
    | Readonly<{ kind: 'issue-agent-tickets'; requestId: string;
        sessions: readonly IssuedAuthSession[]; tickets: readonly PersistedAgentSessionTicket[] }>
    | Readonly<{ kind: 'consume-agent-ticket'; requestId: string; ticketDigest: string;
        capturedAtEpochMs: number }>;
```

Every persisted variant has mandatory fields. HTTP request types stay sparse and separate. The plaintext issued ticket may appear only in the authenticated response/result that returns it to the caller; persisted ticket records contain the mandatory digest instead.

- [ ] **Step 4: Add auth `read -> compute -> validate -> write` and conditional repositories**

Read current user/session/ticket state before the transaction. Compute and validate without repositories, randomness, clocks, or hashing. `write(transaction, computed)` constructs auth repositories from the transaction, performs conditional username/ticket/session guards first, writes dependent indexes/receipts, and inserts any logout socket-close `WS_OUTBOX` effect directly. A zero-row conditional insert/delete throws the shared optimistic conflict for AppInbox retry.

```ts
const written = await repository.deleteTicketIfRevision(
    computed.ticketDigest,
    computed.expectedRevision,
);
requireConditionalWrite(written);
await repository.insertReceipt(computed.receipt);
for (const entry of computed.outboxEntries) {
    await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(entry);
}
```

Remove `AuthSessionRepository.begin`, `lockKey`, and `RuntimeStateJsonStore` retry ownership from these mutation methods. Keep read-only access-token/session lookup direct.

- [ ] **Step 5: Route auth database mutations through AppAuthInboxService**

Config routes submit registration, session issuance after password verification, logout, WS-ticket issuance, agent session/ticket batch issuance, and agent-ticket consumption through AppInbox and wait for their result. WebSocket authentication submits the ticket digest as `AUTH_WS_TICKET_CONSUME` and requires the completed result before upgrading. Logout socket closure is a post-commit WS_OUTBOX effect, not a route callback.

```ts
const result = await appAuthInbox.processAuthenticatedEntryUntilCompletion({
    type: AppInboxType.AUTH_SESSION_LOGOUT,
    topicId: AppInboxType.AUTH_SESSION_LOGOUT,
    resourceId: requestId,
    contextId: authSession.sessionId,
    senderId: authSession.clientId,
    data: command,
});
return toJsonResponse(result);
```

- [ ] **Step 6: Replace AL admission advisory locks with CAS descriptors**

Change inbound/outbound admission write contexts to collect mandatory conditional descriptors: insert-if-absent, replace-if-revision, and delete-if-revision. Apply them in one short backend transaction using runtime-state conditional methods. On a conflict, reread/recompute in the owning AL admission operation; do not expose `lock(key)` and do not use `pg_advisory_xact_lock`. Preserve queue-message idempotency and collision semantics. After all callers are converted, remove `lockKey` from `RuntimeStateTransactionalRepositoryLike` and `PSqlRuntimeStateRepository` so the obsolete advisory-lock escape hatch cannot be copied by future code.

```ts
export type ALAdmissionMutation =
    | Readonly<{ kind: 'insert'; key: string; expected: 'absent'; value: JsonWireValue;
        expireAtEpochMs: number }>
    | Readonly<{ kind: 'replace'; key: string; expectedRevision: number;
        value: JsonWireValue; expireAtEpochMs: number }>
    | Readonly<{ kind: 'delete'; key: string; expectedRevision: number }>;
```

- [ ] **Step 7: Run auth, route, and admission tests**

Run the commands from Step 2 again.

Expected: PASS with every auth DB mutation represented by APP_INBOX, one transaction per winner, no plaintext credential in queue rows, exactly-once ticket consumption by CAS, and no auth/AL advisory lock.

- [ ] **Step 8: Commit auth and admission conversion**

```bash
git add packages/shared-server/rallar-system/services/auth-state-mutations.ts packages/shared-server/rallar-system/services/AppAuthInboxService.ts packages/shared-server/rallar-system/services/AppInboxService.ts packages/shared-server/rallar-system/services/auth-login-service.ts packages/shared-server/rallar-system/repositories/AuthUserRepository.ts packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts packages/shared-server/http/request-auth-service.ts packages/shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts packages/shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts packages/shared-server/runtime-state/RuntimeStateRepository.ts packages/shared/alm/ALInboundAdmissionStore.ts packages/shared/alm/ALOutboundAdmissionStore.ts packages/shared-server/rallar-system/middleware/RallarMiddleware.ts apps/api-v1/src/middleware.ts apps/api-v1/src/routes/config-route.ts apps/api-v1/src/repository/login-repository.ts apps/api-v1/src/routes/ws-routes.ts packages/tests/shared-server/app-auth-inbox-service.test.ts packages/tests/shared-server/auth-login-service.test.ts packages/tests/shared-server/request-auth-service.test.ts packages/tests/shared-server/runtime-state-conditional-writes.test.ts packages/tests/api-v1/psql-inbound-admission-backend.test.ts packages/tests/api-v1/psql-outbound-admission-backend.test.ts apps/api-v1/test/login-repository.test.ts apps/api-v1/test/config-route-auth-logout.test.ts apps/api-v1/test/routes/agent-session-ticket-route.test.ts apps/api-v1/test/request-auth-service.test.ts apps/api-v1/test/ws-routes.test.ts
git commit -m "refactor: route auth writes through app inbox"
```

---

### Task 9: CRDT and Administrative Database Mutation Transactions

**Files:**
- Create: `packages/shared-server/rallar-system/services/crdt-mutations.ts`
- Create: `packages/shared-server/rallar-system/services/AppCrdtInboxService.ts`
- Create: `packages/shared-server/rallar-system/services/AppAdminInboxService.ts`
- Create: `packages/shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts`
- Create: `packages/tests/shared-server/app-crdt-inbox-service.test.ts`
- Create: `packages/tests/shared-server/admin-prune-expired-work.test.ts`
- Create: `apps/api-v1/test/routes/crdt-admin-routes.test.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `packages/shared-server/crdt/RallarCrdtServer.ts`
- Modify: `packages/shared-server/crdt/InMemoryRallarCrdtLogRepository.ts`
- Modify: `packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts`
- Modify: `packages/shared/crdt/crdt-durable-log.ts`
- Modify: `packages/shared/crdt/crdt-hardening.ts`
- Modify: `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
- Modify: `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `apps/api-v1/src/middleware.ts`
- Modify: `apps/api-v1/src/create-rallar-server.ts`
- Modify: `apps/api-v1/src/routes/crdt-admin-routes.ts`
- Modify: `apps/api-v1/src/routes/admin-operations-routes.ts`
- Test: `packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- Test: `packages/tests/shared-server/rallar-crdt-server-topic.test.ts`
- Test: `packages/tests/shared-server/admin-operations-service.test.ts`
- Test: `apps/api-v1/test/routes/admin-operations-routes.test.ts`

**Interfaces:**
- Adds AppInbox types `CRDT_UPDATE_APPEND`, `CRDT_PROJECTION_REBUILD`, `CRDT_SNAPSHOT_COMPACT`, `CRDT_LIFECYCLE_UPDATE`, `CRDT_ERASE`, and `ADMIN_PRUNE_EXPIRED`.
- Produces `CrdtMutationService.read`, `.compute`, `.validate`, and `.write(transaction, computed)` for WS update and HTTP/admin mutations.
- Produces bounded `AdminPruneExpiredWork.read`, `.compute`, `.validate`, and `.write(transaction, computed)` for APP_OUTBOX maintenance pages.
- Reuses `TOPOLOGY_RECONFIGURE` for admin topology recomputation; read-only CRDT/admin POST operations and process-local metrics reset remain direct and are explicitly classified as non-DB-mutating.

- [ ] **Step 1: Write failing CRDT/admin routing, CAS, and atomicity tests**

Cover WS CRDT append, idempotent update replay, update-ID collision, document quota/lifecycle conflict, projection rebuild, snapshot compaction, lifecycle change, erasure, admin topology recompute, and expiry pruning. Inject failures between CRDT metadata, update/snapshot/audit, WS_OUTBOX, result, and completion. Assert rollback, full retry from a fresh read, and no document-row `FOR UPDATE`.

```ts
it('atomically appends a CRDT update and durable websocket effects', async () => {
    await appendThroughAppInbox(command);
    expect(await readUpdate(command.update.updateId)).toEqual(command.update);
    expect(await readDocument(command.update.document)).toMatchObject({ revision: 2 });
    expect(await readWsOutbox(command.update.updateId)).toEqual(expectedReplyAndFanout);
    expect(await readAppInbox(command.commandId)).toMatchObject({ status: 'COMPLETED' });
});
```

- [ ] **Step 2: Run focused tests and confirm direct transaction/row-lock failures**

```bash
npx vitest run packages/tests/shared-server/app-crdt-inbox-service.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/admin-prune-expired-work.test.ts packages/tests/shared-server/admin-operations-service.test.ts
(cd apps/api-v1 && deno test --allow-env --allow-read test/routes/crdt-admin-routes.test.ts test/routes/admin-operations-routes.test.ts)
```

Expected: FAIL because `PSqlCrdtLogRepository.append` starts a transaction and locks the document row, CRDT WS fanout is live, and mutating admin routes invoke repositories/services directly.

- [ ] **Step 3: Add mandatory CRDT commands and pure computed unions**

Persist trusted actor/scope, validated document ref, update/snapshot/lifecycle payload, command ID/hash, captured timestamps, expected document revision/counters, response audience, and expiry in every applicable command. Sparse admin bodies remain boundary types. Use discriminated `accepted`, `replay`, `rejected`, and `write` outcomes; optional fields are not used to represent phase incompleteness.

```ts
export type CrdtMutationComputedWrite = Readonly<{
    outcome: 'write';
    operation: 'append' | 'rebuild-projection' | 'compact' | 'lifecycle' | 'erase';
    documentKey: string;
    expectedDocumentRevision: number | 'absent';
    document: CrdtDocumentMetadata;
    records: readonly CrdtMutationRecord[];
    outboxEntries: readonly ResourceEntry[];
    receipt: CrdtMutationReceipt;
}>;
```

- [ ] **Step 4: Replace the CRDT row lock with revision-guarded writes**

Make the PostgreSQL repository transaction-bound when constructed from `PSqlTransactionSql`; no mutation method calls `begin`. For a new document, conditional insert owns creation. For an existing document, update metadata/counters/lifecycle only at the expected revision, then write update/snapshot/audit/projection rows. A zero-row guard throws the optimistic conflict and the complete AppInbox attempt rolls back.

```sql
update crdt_documents
set document_revision = document_revision + 1,
    last_append_sequence = ${nextAppendSequence},
    update_count = ${nextUpdateCount},
    stored_update_bytes = ${nextStoredUpdateBytes},
    updated_at_epoch_ms = ${updatedAtEpochMs}
where document_key = ${documentKey}
  and document_revision = ${expectedDocumentRevision}
  and lifecycle = ${expectedLifecycle}
  and last_append_sequence = ${expectedAppendSequence}
returning *
```

Keep update-ID uniqueness as the immutable replay/collision check. Do not use `FOR UPDATE`, advisory locks, or service-local retries.

For erasure/audit, write the durable audit record or an immutable APP_OUTBOX audit command in the same transaction. Invoke any process-local or external audit sink only after commit; an external sink is never called from `write`.

- [ ] **Step 5: Route WS CRDT append through AppInbox and durable WS_OUTBOX**

The accepted `WS_INBOX` handler validates transport/scope, enqueues `CRDT_UPDATE_APPEND`, and returns transport acceptance. `AppCrdtInboxService` reruns authorization and document policy, then commits the append, direct response `WS_OUTBOX`, fanout `WS_OUTBOX`, AppInbox result, and completion in one transaction. Recipient resolution stays post-commit; catch-up request/read operations remain direct.

```ts
await appCrdtInbox.enqueue({
    type: AppInboxType.CRDT_UPDATE_APPEND,
    topicId: AppInboxType.CRDT_UPDATE_APPEND,
    resourceId: payload.updateId,
    contextId: toRallarCrdtDocumentKey(payload.document),
    senderId: trusted.sessionId,
    data: toCrdtAppendCommand(payload, trusted, receivedAtEpochMs),
});
```

- [ ] **Step 6: Route mutating CRDT/admin HTTP operations through AppInbox**

Convert both CRDT admin route families: projection rebuild, compact, lifecycle, and erase. Route admin topology recompute through the existing topology command. Keep list, catch-up, integrity, debug/backup export, and process-local metrics reset direct because their tests prove they do not mutate the database.

- [ ] **Step 7: Make expiry pruning bounded APP_OUTBOX work**

`ADMIN_PRUNE_EXPIRED` validates scope/category/dry-run, creates one durable admin-prune job, and writes one deterministic APP_OUTBOX row per requested mutating category. `AdminPruneExpiredWork` processes at most a mandatory configured page size in a queue-handler transaction, uses a conditional bounded delete, writes a successor APP_OUTBOX row when more rows remain, writes progress/result evidence, and reservation-fences completion in that transaction. The last category/page conditionally completes the aggregate job result. The HTTP route waits on that job result through the existing deadline so completed responses retain final per-category counts; a deadline returns the existing pending/timeout shape and never triggers direct pruning. No unbounded scan or multi-category transaction is allowed.

```sql
with expired as (
  select row_id
  from ${approvedTable}
  where expire_ts <= ${capturedNow}
    and row_id > ${afterRowId}
  order by row_id
  limit ${pageSize}
)
delete from ${approvedTable}
where row_id in (select row_id from expired)
returning row_id
```

Table/column selection comes from an exhaustive category mapping, never request interpolation. Queue/resource-inbox pruning must exclude the currently executing row and obey retention policy.

- [ ] **Step 8: Run focused CRDT/admin tests**

Run the commands from Step 2 again.

Expected: PASS with AppInbox coverage for every DB-mutating CRDT/admin operation, revision-CAS conflict recovery, durable WS effects, bounded prune pages, and no CRDT domain row lock.

- [ ] **Step 9: Commit CRDT and administrative conversion**

```bash
git add packages/shared-server/rallar-system/services/crdt-mutations.ts packages/shared-server/rallar-system/services/AppCrdtInboxService.ts packages/shared-server/rallar-system/services/AppAdminInboxService.ts packages/shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts packages/shared-server/rallar-system/services/AppInboxService.ts packages/shared-server/crdt/RallarCrdtServer.ts packages/shared-server/crdt/InMemoryRallarCrdtLogRepository.ts packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts packages/shared/crdt/crdt-durable-log.ts packages/shared/crdt/crdt-hardening.ts packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts packages/shared-server/rallar-system/middleware/RallarMiddleware.ts apps/api-v1/src/middleware.ts apps/api-v1/src/create-rallar-server.ts apps/api-v1/src/routes/crdt-admin-routes.ts apps/api-v1/src/routes/admin-operations-routes.ts packages/tests/shared-server/app-crdt-inbox-service.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/admin-prune-expired-work.test.ts packages/tests/shared-server/admin-operations-service.test.ts apps/api-v1/test/routes/crdt-admin-routes.test.ts apps/api-v1/test/routes/admin-operations-routes.test.ts
git commit -m "refactor: route crdt and admin writes through app inbox"
```

---

### Task 10: HTTP and WebSocket Mutation-Route Closure

**Files:**
- Create: `packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `apps/api-v1/src/routes/config-route.ts`
- Modify: `apps/api-v1/src/routes/client-state-routes.ts`
- Modify: `apps/api-v1/src/routes/group-state-routes.ts`
- Modify: `apps/api-v1/src/routes/graph-topology-routes.ts`
- Modify: `apps/api-v1/src/routes/crdt-admin-routes.ts`
- Modify: `apps/api-v1/src/routes/admin-operations-routes.ts`
- Modify: `apps/api-v1/src/routes/ws-routes.ts`
- Modify: `packages/shared-server/crdt/RallarCrdtServer.ts`
- Modify: `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify: `packages/shared-server/rallar-system/services/ws-lifecycle-service.ts`
- Modify: `packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts`
- Modify: `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- Modify: `apps/api-v1/test/config-route-auth-logout.test.ts`
- Modify: `apps/api-v1/test/routes/agent-session-ticket-route.test.ts`
- Modify: `apps/api-v1/test/routes/crdt-admin-routes.test.ts`
- Modify: `apps/api-v1/test/routes/admin-operations-routes.test.ts`
- Modify: `apps/api-v1/test/ws-routes.test.ts`
- Modify: `apps/api-v1/test/services/ws-topic-room-authorizer.test.ts`
- Modify: `packages/tests/shared-server/read-compute-write-contract.test.ts`
- Test: `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

**Interfaces:**
- Consumes: client, group, topology, auth, CRDT, and admin AppInbox command APIs from Tasks 5–9.
- Produces: one explicit mutation-route inventory used by the structural test; every entry names transport, route/topic, AppInbox type, and owning service operation.
- Produces: `AppInboxService.enqueue(command): Promise<ResourceEntry>` for durable transport acceptance without synchronous result waiting.

- [ ] **Step 1: Write the mutation-route inventory test**

Create a required inventory containing every mutating HTTP method/path and WS topic/lifecycle callback. Assert each HTTP route depends on AppInbox, each mutating WS handler enqueues APP_INBOX, and no route imports a mutating service implementation.

```ts
const mutations = [
    AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    AppInboxType.CLIENT_INSTANCE_UPSERT,
    AppInboxType.CLIENT_SESSION_CONNECT,
    AppInboxType.CLIENT_SESSION_HEARTBEAT,
    AppInboxType.CLIENT_SESSION_DISCONNECT,
    AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    AppInboxType.CLIENT_EXPIRED_SESSIONS,
    AppInboxType.AUTH_USER_REGISTER,
    AppInboxType.AUTH_SESSION_ISSUE,
    AppInboxType.AUTH_SESSION_LOGOUT,
    AppInboxType.AUTH_WS_TICKET_ISSUE,
    AppInboxType.AUTH_WS_TICKET_CONSUME,
    AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
    AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
    AppInboxType.GROUP_CREATE,
    AppInboxType.GROUP_UPDATE,
    AppInboxType.GROUP_DIRECTOR_APPOINT,
    AppInboxType.GROUP_JOIN,
    AppInboxType.GROUP_INVITE_CREATE,
    AppInboxType.GROUP_INVITE_REVOKE,
    AppInboxType.GROUP_INVITE_ACCEPT,
    AppInboxType.GROUP_JOIN_CODE_ROTATE,
    AppInboxType.GROUP_MEMBER_REMOVE,
    AppInboxType.GROUP_MEMBER_BAN,
    AppInboxType.GROUP_MEMBER_UNBAN,
    AppInboxType.GROUP_MEMBER_ROLE_SET,
    AppInboxType.GROUP_OWNERSHIP_TRANSFER,
    AppInboxType.GROUP_MEMBER_UPSERT,
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT,
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
    AppInboxType.RTC_RTT_SUBMIT,
    AppInboxType.CRDT_UPDATE_APPEND,
    AppInboxType.CRDT_PROJECTION_REBUILD,
    AppInboxType.CRDT_SNAPSHOT_COMPACT,
    AppInboxType.CRDT_LIFECYCLE_UPDATE,
    AppInboxType.CRDT_ERASE,
    AppInboxType.ADMIN_PRUNE_EXPIRED,
] as const;

expect(new Set(mutations)).toEqual(new Set(Object.values(AppInboxType)));

const requiredOwners = {
    'client-state-routes': [
        AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        AppInboxType.CLIENT_INSTANCE_UPSERT,
        AppInboxType.CLIENT_SESSION_CONNECT,
        AppInboxType.CLIENT_SESSION_HEARTBEAT,
        AppInboxType.CLIENT_SESSION_DISCONNECT,
    ],
    'ws-routes-and-lifecycle': [
        AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
        AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    ],
    'client-maintenance': [AppInboxType.CLIENT_EXPIRED_SESSIONS],
    'config-and-auth-routes': [
        AppInboxType.AUTH_USER_REGISTER,
        AppInboxType.AUTH_SESSION_ISSUE,
        AppInboxType.AUTH_SESSION_LOGOUT,
        AppInboxType.AUTH_WS_TICKET_ISSUE,
        AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
        AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
    ],
    'ws-auth-upgrade': [AppInboxType.AUTH_WS_TICKET_CONSUME],
    'group-state-routes-and-lifecycle': [
        AppInboxType.GROUP_CREATE,
        AppInboxType.GROUP_UPDATE,
        AppInboxType.GROUP_DIRECTOR_APPOINT,
        AppInboxType.GROUP_JOIN,
        AppInboxType.GROUP_INVITE_CREATE,
        AppInboxType.GROUP_INVITE_REVOKE,
        AppInboxType.GROUP_INVITE_ACCEPT,
        AppInboxType.GROUP_JOIN_CODE_ROTATE,
        AppInboxType.GROUP_MEMBER_REMOVE,
        AppInboxType.GROUP_MEMBER_BAN,
        AppInboxType.GROUP_MEMBER_UNBAN,
        AppInboxType.GROUP_MEMBER_ROLE_SET,
        AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        AppInboxType.GROUP_MEMBER_UPSERT,
        AppInboxType.GROUP_PRESENCE_CONNECT,
        AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        AppInboxType.GROUP_PRESENCE_DISCONNECT,
    ],
    'graph-topology-routes': [
        AppInboxType.TOPOLOGY_CONFIG_PUT,
        AppInboxType.TOPOLOGY_CONFIG_DELETE,
        AppInboxType.TOPOLOGY_OVERRIDE_PUT,
        AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
        AppInboxType.TOPOLOGY_RECONFIGURE,
    ],
    'rtc-rtt-ws-topic': [AppInboxType.RTC_RTT_SUBMIT],
    'crdt-ws-topic': [AppInboxType.CRDT_UPDATE_APPEND],
    'crdt-admin-routes': [
        AppInboxType.CRDT_PROJECTION_REBUILD,
        AppInboxType.CRDT_SNAPSHOT_COMPACT,
        AppInboxType.CRDT_LIFECYCLE_UPDATE,
        AppInboxType.CRDT_ERASE,
    ],
    'admin-operations-routes': [
        AppInboxType.TOPOLOGY_RECONFIGURE,
        AppInboxType.ADMIN_PRUNE_EXPIRED,
        AppInboxType.CRDT_SNAPSHOT_COMPACT,
        AppInboxType.CRDT_LIFECYCLE_UPDATE,
        AppInboxType.CRDT_ERASE,
    ],
} as const;
```

- [ ] **Step 2: Run the structural and route tests to expose bypasses**

Run:

```bash
npx vitest run packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts
(cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-api-routes-hardening.test.ts test/config-route-auth-logout.test.ts test/routes/agent-session-ticket-route.test.ts test/routes/crdt-admin-routes.test.ts test/routes/admin-operations-routes.test.ts test/ws-routes.test.ts test/services/ws-topic-room-authorizer.test.ts)
```

Expected: FAIL with any auth, graph, RTT, CRDT, topology lifecycle, administration, or maintenance caller that still invokes a mutating repository/service directly.

Also add a result-wait timeout case proving the HTTP request can reach its existing pending/timeout response while the durable APP_INBOX row remains eligible; the route must never invoke a direct mutator as a fallback.

- [ ] **Step 3: Convert remaining HTTP mutation bypasses**

Normalize and authenticate before enqueue, persist immutable facts in the AppInbox command, wait through the existing result API, and preserve response/receipt status mappings. Never fall back to a direct write when the synchronous result wait expires.

```ts
const enqueue = toAuthenticatedAppInboxCommand({
    requestId,
    actor,
    command: normalizeMutationRequest(body),
    capturedAtEpochMs: now(),
});
return await appInbox.processAuthenticatedEntryUntilCompletion(enqueue);
```

- [ ] **Step 4: Convert remaining WS and lifecycle mutation bypasses**

Keep `WS_INBOX` as transport durability. Its mutating callbacks enqueue deterministic APP_INBOX commands and return/acknowledge only transport acceptance. Authorized connect/disconnect, ticket consumption, group session cleanup, RTT submission, CRDT append, topology reconfigure/remove, and expiry reconciliation all use AppInbox or APP_OUTBOX commands.

```ts
await appInbox.enqueue({
    type: AppInboxType.RTC_RTT_SUBMIT,
    topicId: AppInboxType.RTC_RTT_SUBMIT,
    resourceId: message.id.msgId,
    contextId: toScopedGroupContextId(payload.group),
    senderId: authenticated.principalId,
    data: toRtcRttCommand(payload, authenticated, receivedAtEpochMs),
});
return { status: 'accepted', commandId: message.id.msgId };
```

- [ ] **Step 5: Add an explicit source guard**

Extend `read-compute-write-contract.test.ts` to reject mutating service/repository imports from `apps/api-v1/src/routes/**`, `RallarCrdtServer.ts`, `ws-system-topics.ts`, and `ws-lifecycle-service.ts`. Reject direct calls named `registerAuthUser`, `putSession`, `deleteSession`, `putWebSocketTicket`, `consumeWebSocketTicket`, `putAgentSessionTicket`, `consumeAgentSessionTicket`, `upsertPrincipal`, `upsertInstance`, `connectSession`, `heartbeatSession`, `disconnectSession`, `createGroup`, `updateGroup`, `joinGroup`, `putConfig`, `deleteConfig`, `putOverride`, `deleteOverride`, `reconfigureGroupTopology`, `removeGroupTopology`, `writeTopologyMutation`, `writeRttMutation`, `writeSnapshot`, `updateDocumentLifecycle`, and unwrapped CRDT `append`. Read-only authentication lookup, topology reads, CRDT catch-up/integrity/export, and process-local metric reset remain permitted by an explicit allowlist.

```ts
for (const name of forbiddenDirectMutators) {
    expect(routeAndWsSource).not.toMatch(new RegExp(`\\.${name}\\s*\\(`));
}
```

- [ ] **Step 6: Run route closure tests**

Run the commands from Step 2 again.

Expected: PASS with a complete inventory, no direct HTTP/WS DB mutation, and unchanged read-only routing.

- [ ] **Step 7: Commit route closure**

```bash
git add packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/shared-server/rallar-system/services/AppInboxService.ts apps/api-v1/src/routes/config-route.ts apps/api-v1/src/routes/client-state-routes.ts apps/api-v1/src/routes/group-state-routes.ts apps/api-v1/src/routes/graph-topology-routes.ts apps/api-v1/src/routes/crdt-admin-routes.ts apps/api-v1/src/routes/admin-operations-routes.ts apps/api-v1/src/routes/ws-routes.ts packages/shared-server/crdt/RallarCrdtServer.ts packages/shared-server/rallar-system/ws-system-topics.ts packages/shared-server/rallar-system/services/ws-lifecycle-service.ts packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts apps/api-v1/test/routes/state-api-routes-hardening.test.ts apps/api-v1/test/config-route-auth-logout.test.ts apps/api-v1/test/routes/agent-session-ticket-route.test.ts apps/api-v1/test/routes/crdt-admin-routes.test.ts apps/api-v1/test/routes/admin-operations-routes.test.ts apps/api-v1/test/ws-routes.test.ts apps/api-v1/test/services/ws-topic-room-authorizer.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts
git commit -m "refactor: close app inbox mutation bypasses"
```

---

### Task 11: Remove the Intermediate State-Mutation Outbox

**Files:**
- Create: `packages/shared-server/rallar-system/services/mutation-command-identity.ts`
- Delete: `packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts`
- Delete: `packages/shared-server/rallar-system/services/StateMutationOutboxWork.ts`
- Delete: `packages/tests/shared-server/state-mutation-outbox.test.ts`
- Modify: `packages/shared-server/rallar-system/services/AppInboxService.ts`
- Modify: `packages/shared-server/rallar-system/services/client-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/group-topology-config-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify: `packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts`
- Modify: `packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `apps/api-v1/src/middleware.ts`
- Modify: `packages/shared-server/mod.ts`
- Test: `packages/tests/shared-server/read-compute-write-contract.test.ts`
- Test: `packages/tests/shared-server/rallar-middleware.test.ts`

**Interfaces:**
- Produces: `hashMutationCommand`, `serializeCanonicalMutationCommand`, and deterministic command/effect identity helpers in the neutral identity module.
- Removes: all `StateMutationOutbox*` public exports, middleware options, worker lifecycle, pending scans, delivery CAS, and state-mutation wake paths.
- Consumes: final direct ResourceInbox writes proven by Tasks 4–8.

- [ ] **Step 1: Prove the intermediate implementation never reached supported main**

Run:

```bash
git merge-base --is-ancestor f6a4e24e origin/main
```

Expected: exit 1, proving the commit that introduced `StateMutationOutboxRepository` is not an ancestor of supported `origin/main`. Record the command and result in the task handoff. If it unexpectedly exits 0, stop this task and add a bounded deployment migration before deletion; do not discard pending deployed work.

- [ ] **Step 2: Write a failing absence/architecture test**

Extend the structural contract to reject the namespace, repository, worker, exports, middleware option, or service imports:

```ts
for (const forbidden of [
    'state-mutation:outbox',
    'StateMutationOutboxRepository',
    'StateMutationOutboxWork',
]) {
    expect(trackedRuntimeSource).not.toContain(forbidden);
}
```

Run:

```bash
npx vitest run packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/rallar-middleware.test.ts
```

Expected: FAIL while the intermediate files and wiring remain.

- [ ] **Step 3: Move reusable command identity helpers**

Move canonical JSON and SHA-256 helpers without changing their wire output. Name APIs with verbs:

```ts
export async function hashMutationCommand(command: JsonWireValue): Promise<string>;
export function serializeCanonicalMutationCommand(command: JsonWireValue): string;
```

Update client, group, topology, RTT, and AppInbox imports before deleting the repository.

- [ ] **Step 4: Delete the intermediate repository, worker, and wiring**

Remove the files, namespace, delivery records, middleware configuration, drain loop, worker wake, public exports, and worker-only tests. Do not replace them with another intent abstraction. Retain only direct `APP_OUTBOX`/`WS_OUTBOX` QueueBox workers.

- [ ] **Step 5: Run absence and focused mutation tests**

Run:

```bash
npx vitest run packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/direct-resource-outbox.test.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
```

Expected: PASS and `rg -n "StateMutationOutbox|state-mutation:outbox" packages apps` returns no runtime match.

- [ ] **Step 6: Commit the removal**

```bash
git add packages/shared-server/rallar-system/services/mutation-command-identity.ts packages/shared-server/rallar-system/services/AppInboxService.ts packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/services/group-state-mutations.ts packages/shared-server/rallar-system/services/group-topology-config-mutations.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts packages/shared-server/rallar-system/middleware/RallarMiddleware.ts apps/api-v1/src/middleware.ts packages/shared-server/mod.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/rallar-middleware.test.ts
git add -u packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts packages/shared-server/rallar-system/services/StateMutationOutboxWork.ts packages/tests/shared-server/state-mutation-outbox.test.ts
git commit -m "refactor: remove intermediate mutation outbox"
```

---

### Task 12: Performance and Black-Box Evidence for the New Boundary

**Files:**
- Modify: `scripts/perf/api-v1-state-write-concurrency-bench.ts`
- Modify: `scripts/perf/compare-api-v1-state-write-results.mjs`
- Modify: `scripts/perf/README.md`
- Modify: `packages/tests/shared-server/state-write-performance-harness.test.ts`
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-write-convergence.json`
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json`
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-auth-session.json`
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json`
- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-crdt-app-inbox.json`
- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/shared-test/package.json`
- Modify: `package.json`

**Interfaces:**
- Replaces performance evidence `outbox intents` with final `resource_inbox` APP_OUTBOX/WS_OUTBOX rows linked by command/effect identity.
- Replaces service-local attempt evidence with AppInbox entry attempts, retry delay, due age, and selected lane.
- Preserves artifact validation totality and the existing scale/performance gates.

- [ ] **Step 1: Write failing artifact and recipe assertions**

Require every accepted command to have its exact durable receipt and expected final ResourceInbox effects in the same database observation. Reject any candidate artifact containing intermediate intent evidence or service-local retry delay. Add recipe contract assertions for auth ticket single-consumption, CRDT append plus durable fanout, and bounded admin pruning so the route-closure claim is exercised beyond client/group/topology state.

```ts
expect(candidate.measurement.counterSources.outbox).toBe('resource_inbox');
expect(candidate.measurement.counterSources.attempts).toBe('app_inbox.ri_attempts');
expect(candidate.durableEvidence.intermediateMutationIntents).toEqual([]);
expect(candidate.correctness.atomicCompletionFailures).toBe(0);
```

- [ ] **Step 2: Run harness contract tests and confirm old evidence fails**

Run:

```bash
npx vitest run packages/tests/shared-server/state-write-performance-harness.test.ts
npm run check:shared-test
```

Expected: FAIL because the current harness queries `StateMutationOutboxRepository` and reports production service retry observations.

- [ ] **Step 3: Update performance evidence collection**

Query `resource_inbox` for deterministic `APP_OUTBOX`/`WS_OUTBOX` entries and `APP_INBOX` attempts/results. Record per-command transaction duration, SQL/row/byte counts, conflict classification, exact delay, fairness/timeout recovery, and final completion. Keep setup/evidence queries outside measured mutation latency.

```ts
type StateWriteDurableEvidence = Readonly<{
    appInbox: readonly AppInboxAttemptEvidence[];
    receipts: readonly MutationReceiptEvidence[];
    resourceOutbox: readonly ResourceOutboxEvidence[];
    intermediateMutationIntents: readonly [];
    atomicCompletionFailures: number;
}>;
```

- [ ] **Step 4: Update convergence recipes**

For every accepted mutation, assert one completed APP_INBOX result, no partial state/event/receipt/outbox combination, expected final outbox effects, and convergence across two api-v1 processes. Add a conflict injection that succeeds during the five fast retries and an overdue entry fixture recovered by the fairness lane. Have the runner expose the durable evidence as the named `stateWriteEvidence` recipe output before these assertions. Extend the auth recipe to race one ticket between two consumers, add a CRDT recipe that observes the append response/fanout after commit on two servers, and extend admin operations to prove bounded prune progress and completion.

```json
{
  "name": "assertAtomicAppInboxCompletion",
  "type": "assert",
  "actual": {
    "atomicCompletionFailures": "{stateWriteEvidence.atomicCompletionFailures}",
    "intermediateMutationIntents": "{stateWriteEvidence.intermediateMutationIntents}"
  },
  "expect": {
    "body": {
      "atomicCompletionFailures": 0,
      "intermediateMutationIntents": []
    }
  }
}
```

Companion `type: "assert"` steps compare `stateWriteEvidence.intermediateMutationIntents` with `[]`, prove every accepted command has a `COMPLETED` APP_INBOX row, and prove the overdue fixture records `selectedLane: "fairness"` without running before its persisted `next_ts`.

- [ ] **Step 5: Run focused harness and recipe validation**

Run:

```bash
npx vitest run packages/tests/shared-server/state-write-performance-harness.test.ts
npm run check:shared-test
npm run test:api-v1:black-box:recipes
```

Expected: PASS with no intermediate-intent schema accepted and all new recipe steps validating.

- [ ] **Step 6: Capture candidate and compare it with the governed baseline**

Run with PostgreSQL available:

```bash
npm run db:up
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:migrate
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
```

Expected: candidate validation and comparison PASS; uncontended p95/p99 regression stays within five percent, shared/hot throughput does not regress, no unexplained SQL/row/byte/transaction increase remains, and uncontended/shared retry exhaustion is zero.

- [ ] **Step 7: Run the unweakened medium-scale gate**

Run:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
```

Expected: PASS with 100 authenticated clients, five converged groups, ten client lanes, five group/topology lanes, two api-v1 processes, zero lost writes, zero duplicate effects, and final topology causal tuples matching final group state.

- [ ] **Step 8: Commit evidence updates**

```bash
git add scripts/perf/api-v1-state-write-concurrency-bench.ts scripts/perf/compare-api-v1-state-write-results.mjs scripts/perf/README.md packages/tests/shared-server/state-write-performance-harness.test.ts packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-write-convergence.json packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json packages/shared-test/black-box-runner/tests/api-v1/api-v1-auth-session.json packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json packages/shared-test/black-box-runner/tests/api-v1/api-v1-crdt-app-inbox.json packages/shared-test/black-box-runner/api-v1-black-box-run.mts packages/shared-test/black-box-runner/recipe-matrix.json packages/shared-test/package.json package.json
git commit -m "test: prove app inbox transactional convergence"
```

---

### Task 13: Mandatory Contracts, Documentation, and AI Architecture Guards

**Files:**
- Modify: `AGENTS.md`
- Modify: `.agents/skills/rallar-platform/SKILL.md`
- Modify: `.agents/skills/rallar-realtime/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/references/package-code-style.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `packages/shared-server/architecture.md`
- Modify: `packages/shared-server/rallar-server-repositories.md`
- Modify: `packages/shared-server/rallar-server-repositories-improvements.md`
- Modify: `apps/api-v1/README.md`
- Modify: `docs/rallar-api-reference.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`
- Modify: `docs/rallar-crdt-guide.md`
- Modify: `docs/rallar-crdt-production-hardening-runbook.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-21-guarded-runtime-state-batch-design.md`
- Modify: `docs/superpowers/specs/2026-07-21-in-process-cas-contention-suppression-design.md`
- Modify: `packages/tests/shared/authoritative-state-contracts.test.ts`
- Modify: `packages/tests/shared-server/read-compute-write-contract.test.ts`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`

**Interfaces:**
- Produces repository-wide AI guidance matching the approved spec.
- Keeps authoritative shared fields mandatory and sparse construction inputs separate.
- Makes stale architecture text fail a structural test.

- [ ] **Step 1: Write failing documentation/contract guards**

Add assertions that tracked architecture guidance contains all required rules and rejects stale patterns in current guidance:

```ts
for (const required of [
    'AppInbox is mandatory for incoming database mutations',
    'service write receives the transaction',
    'ResourceInboxRepository',
    'APP_OUTBOX',
    'WS_OUTBOX',
    '20 total processing attempts',
    'mandatory fields by default',
]) expect(currentGuidance).toContain(required);

for (const rejected of [
    'write opens the transaction',
    '[0, 2, 8]',
    'StateMutationOutboxWork',
]) expect(currentGuidance).not.toContain(rejected);
```

Scope `currentGuidance` to active AGENTS, skills, architecture, repository, and API docs; historical superseded specs may name rejected mechanisms when explaining their removal.

- [ ] **Step 2: Run guards and confirm stale guidance fails**

Run:

```bash
npx vitest run packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: FAIL because active guidance still says service `write` opens transactions, uses `[0, 2, 8]`, or drains an intermediate mutation outbox.

- [ ] **Step 3: Update AGENTS and repo skills**

State unambiguously:

- AppInbox is mandatory for incoming HTTP/WS DB mutations;
- AppInbox owns the transaction and retry boundary;
- service `write(transaction, computed)` never opens a transaction;
- final APP_OUTBOX/WS_OUTBOX rows are written directly through the same transaction;
- no intermediate mutation outbox is architectural precedent;
- queue locks are coordination-only;
- computed persistence data is not called a plan;
- the staged 20-attempt schedule and fairness lane are shared defaults;
- authoritative persisted/shared contracts require mandatory fields.

Make clear that “incoming mutation” includes authentication/session/ticket state, CRDT WS append and mutating admin operations. Document that AL admission and auth/CRDT domain writes use conditional insert/update/delete fencing; advisory locks and CRDT document-row locks are not approved queue-claim exceptions.

Update `rallar-code-writing/references/package-code-style.md` with the same rules; it currently presents `DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS` and service-owned transactions as the preferred api-v1 mutation pattern.

- [ ] **Step 4: Update architecture and API docs**

Replace old flows with:

```text
HTTP/WS mutation
  -> APP_INBOX
  -> read -> compute -> validate
  -> AppInbox transaction
       -> service.write(transaction, computed)
       -> authoritative state/event/receipt
       -> APP_OUTBOX/WS_OUTBOX
       -> result + reservation-fenced completion
  -> commit
  -> wake/poll workers
```

Document that the synchronous result wait never falls back to direct mutation and that WS logical audience resolution occurs after commit.

Mark the 2026-07-21 guarded-batch and in-process contention-suppression designs as superseded for api-v1 mutation transaction/retry ownership by the approved 2026-07-22 AppInbox design. Preserve their measured historical evidence, but add a prominent status and replacement link so their three-attempt service-local retry text cannot be used as current architecture precedent.

- [ ] **Step 5: Run contract and documentation guards**

Run:

```bash
npx vitest run packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/rallar-server-schema-docs.test.ts packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: PASS with no unjustified optional authoritative field and no stale active architecture rule.

- [ ] **Step 6: Commit guidance**

```bash
git add AGENTS.md .agents/skills/rallar-platform/SKILL.md .agents/skills/rallar-realtime/SKILL.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/package-code-style.md .agents/skills/rallar-testing/SKILL.md .agents/skills/rallar-testing/references/test-commands.md packages/shared-server/architecture.md packages/shared-server/rallar-server-repositories.md packages/shared-server/rallar-server-repositories-improvements.md apps/api-v1/README.md docs/rallar-api-reference.md docs/rallar-convergent-state-and-rtc-topology.md docs/rallar-crdt-guide.md docs/rallar-crdt-production-hardening-runbook.md docs/README.md docs/superpowers/specs/2026-07-21-guarded-runtime-state-batch-design.md docs/superpowers/specs/2026-07-21-in-process-cas-contention-suppression-design.md packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/repo/rallar-skill-integrity.test.ts
git commit -m "docs: codify app inbox transaction ownership"
```

---

### Task 14: Final Static, Focused, PostgreSQL, and Lock Audit Gate

**Files:**
- Modify only files required by failures that reproduce a requirement in Tasks 1–13.
- Do not weaken test scale, retry limits, performance thresholds, contract assertions, or route inventory to make this task pass.

**Interfaces:**
- Consumes every preceding task.
- Produces the final validation record and clean implementation branch ready for code review.

- [ ] **Step 1: Run scoped architecture searches**

Run:

```bash
rg -n "StateMutationOutbox|state-mutation:outbox" packages apps AGENTS.md .agents/skills packages/shared-server/architecture.md packages/shared-server/rallar-server-repositories.md packages/shared-server/rallar-server-repositories-improvements.md apps/api-v1/README.md docs/rallar-api-reference.md docs/rallar-convergent-state-and-rtc-topology.md docs/rallar-crdt-guide.md docs/rallar-crdt-production-hardening-runbook.md
rg -n "DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS|waitForRuntimeStateWriteRetry|RuntimeStateRetryExhaustedError|\[0, 2, 8\]" packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/services/group-state-guarded-batch.ts packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts packages/shared-server/rallar-system/services/auth-login-service.ts packages/shared-server/rallar-system/services/auth-state-mutations.ts packages/shared-server/rallar-system/services/crdt-mutations.ts packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts packages/shared-server/rallar-system/repositories/RtcRttRepository.ts
rg -n "\.begin\(" packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/services/group-state-guarded-batch.ts packages/shared-server/rallar-system/services/GroupPresenceSummaryWork.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts packages/shared-server/rallar-system/services/rtc-rtt-mutation-service.ts packages/shared-server/rallar-system/services/auth-login-service.ts packages/shared-server/rallar-system/services/auth-state-mutations.ts packages/shared-server/rallar-system/services/crdt-mutations.ts packages/shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts apps/api-v1/src/routes
rg -n "FOR UPDATE|for update|pg_advisory|lockKey\(" packages/shared-server packages/shared apps/api-v1/src
rg -n "\bplan\b|\bPlan\b" packages/shared-server/rallar-system/services packages/shared-server/rallar-system/repositories
rg -n "^## Status|Superseded.*2026-07-22-api-v1-app-inbox-transactional-mutations-design" docs/superpowers/specs/2026-07-21-guarded-runtime-state-batch-design.md docs/superpowers/specs/2026-07-21-in-process-cas-contention-suppression-design.md
```

Expected:

- no runtime intermediate mutation-outbox match in active code/guidance;
- no service-local retry helper/backoff match in the converted mutation services/repositories; unrelated generic runtime-state consumers are outside this AppInbox gate;
- no `begin` in converted service writes or routes;
- the only `FOR UPDATE` matches are bounded ResourceInbox queue claiming; there is no advisory-lock API/call, auth/AL lock, or CRDT document-row lock;
- no computed mutation data uses “plan”; project planning references outside runtime code are irrelevant.
- both historical 2026-07-21 designs are visibly superseded by the approved design instead of silently rewritten as current evidence.

- [ ] **Step 2: Run focused Vitest suites**

```bash
npx vitest run packages/tests/shared/resource-inbox-retry-policy.test.ts packages/tests/shared/resource-inbox-repository.test.ts packages/tests/shared/resource-inbox-start-processing.test.ts packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/shared-server/postgres-transaction-boundary.test.ts packages/tests/shared-server/app-inbox-transaction.test.ts packages/tests/shared-server/direct-resource-outbox.test.ts packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts packages/tests/shared-server/app-auth-inbox-service.test.ts packages/tests/shared-server/app-crdt-inbox-service.test.ts packages/tests/shared-server/admin-prune-expired-work.test.ts packages/tests/api-v1/psql-inbound-admission-backend.test.ts packages/tests/api-v1/psql-outbound-admission-backend.test.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/rtc-topology-mutations.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/state-write-performance-harness.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run api-v1 Deno checks and focused route tests**

```bash
(cd apps/api-v1 && deno task check)
(cd apps/api-v1 && deno test --allow-env --allow-read test/services/client-state-service.test.ts test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts test/routes/graph-topology-routes.test.ts test/config-route-auth-logout.test.ts test/routes/agent-session-ticket-route.test.ts test/login-repository.test.ts test/request-auth-service.test.ts test/routes/crdt-admin-routes.test.ts test/routes/admin-operations-routes.test.ts test/ws-routes.test.ts test/services/ws-topic-room-authorizer.test.ts)
```

Expected: both commands exit 0.

- [ ] **Step 4: Run shared-test validation and ordinary api-v1 recipes**

```bash
npm run check:shared-test
npm run test:api-v1:black-box:recipes
```

Expected: both commands exit 0.

- [ ] **Step 5: Run PostgreSQL concurrency, performance, and medium-scale gates**

With the required services available, run:

```bash
npm run db:up
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:migrate
npm run test:optional:postgres
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
npm run test:api-v1:black-box:postgres:medium-scale
```

Expected: all commands PASS. Report any environment-unavailable command as skipped with the exact missing service; do not claim the final gate passed while it is skipped.

- [ ] **Step 6: Inspect the final diff and return reproduced failures to the owning task**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: `git diff --check` exits 0 and `git status --short` contains no uncommitted implementation files. If validation exposes a defect, return to the task that owns the failing interface, add a focused failing regression there, implement and commit that correction using the owning task's explicit file list, and then rerun Tasks 14.1–14.5. Do not create an empty final-validation commit.

## Completion Criteria

- Every incoming HTTP or WebSocket DB mutation is represented by the structural AppInbox inventory and has no direct service-write bypass.
- Every targeted service visibly executes `read -> compute -> validate -> write(transaction, computed)`; no service owns a transaction, retry loop, sleep, or live delivery.
- A winning mutation atomically commits its authoritative guard/dependent state, event, receipt, exact APP_OUTBOX/WS_OUTBOX entries, AppInbox result, and reservation-fenced completion.
- A failure in any write rolls the complete transaction back. A conflict schedules ResourceInbox retry and the next attempt rereads/recomputes/revalidates.
- Retry attempts use the approved millisecond-then-seconds schedule, stop automatic processing after attempt 20, and retain a separately rate-limited 30-second-overdue fairness lane.
- WS outbox insertion does not depend on current local recipients; recipient resolution and socket delivery occur post-commit.
- Registration, auth-session issuance/logout, one-time ticket issuance/consumption, CRDT WS append/admin writes, topology administration, and expiry pruning are included in AppInbox coverage; plaintext credentials are not persisted in queue commands.
- Auth/AL admission uses conditional fencing, CRDT document changes use expected revisions, and administrative pruning uses bounded APP_OUTBOX pages.
- `StateMutationOutboxRepository`, `StateMutationOutboxWork`, their namespace, and their middleware/public wiring are absent.
- Queue claiming may use `FOR UPDATE SKIP LOCKED`; client, group, topology, publication, RTT, auth, AL admission, CRDT, and admin domain paths contain no application row/table/advisory lock, and the obsolete runtime-state `lockKey` API is absent.
- Authoritative persisted/shared contracts remain mandatory by default and sparse input types remain separate.
- Focused unit, Deno, Postgres, performance comparison, and two-server 100-client/five-group convergence gates pass without weakened scale or thresholds.
- Active AI guidance and architecture docs encode AppInbox transaction/retry ownership, transaction-receiving service writes, direct ResourceInbox outboxes, computed terminology, mandatory fields, and the queue-lock/domain-lock distinction.
