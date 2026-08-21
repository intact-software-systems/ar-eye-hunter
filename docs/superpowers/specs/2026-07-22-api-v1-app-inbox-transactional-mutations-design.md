# API-v1 AppInbox Transactional Mutations Design

## Status

Approved in conversation on 2026-07-22. This design supersedes the transaction
ownership, mutation-outbox, and retry-loop decisions in
`plans/api-v1-convergent-database-writing-remediation-plan.md`. That
implementation plan must be revised after this specification is reviewed; it
must not be executed in its current form.

## Goal

Route every incoming HTTP or WebSocket command that can mutate api-v1 database
state through AppInbox. Keep each owning service explicit and readable as
`read -> compute -> validate -> write`, while making one AppInbox-owned
PostgreSQL transaction atomically commit the authoritative mutation, dependent
state, event, idempotency receipt, applicable `APP_OUTBOX` and `WS_OUTBOX`
entries, AppInbox result, and incoming AppInbox completion.

The architecture remains optimistic, permissive, convergent, and eventually
consistent. Domain state uses compare-and-set writes rather than application
row, table, or advisory locks. Queue row claiming may continue to use
`FOR UPDATE SKIP LOCKED` as queue coordination; that mechanism is not a domain
state concurrency precedent.

## Approved Decisions

1. AppInbox is the mandatory command boundary for incoming HTTP and WebSocket
   traffic that can mutate the database.
2. Owning services expose operations expressed with verbs: `read`, `compute`,
   `validate`, and `write`.
3. The output of `compute` is called `computed` or a domain-specific computed
   value. It is never called a plan. The word “plan” is reserved for project
   planning artifacts, not data awaiting persistence.
4. `read`, `compute`, and `validate` execute before the write transaction.
   `compute` and `validate` are deterministic and have no repository, clock,
   randomness, environment, publication, or transaction access.
5. `write` receives the active database transaction. A service `write`
   operation must not call `begin`, commit, roll back, sleep, retry, perform
   external I/O, or invoke another independently transactional repository.
6. AppInbox uses one small database transaction utility to create the
   transaction, invoke the callback, commit on success, and roll back on error.
7. Each service `write` operation constructs or receives repositories bound to
   that exact transaction, including `ResourceInboxRepository`.
8. Services write their final durable `APP_OUTBOX` and `WS_OUTBOX` rows directly
   to `resource_inbox` in the mutation transaction. There is no intermediate
   state-mutation outbox in the normal path and no need for
   `StateMutationOutboxWork`.
9. Outbox consumers perform topology computation, WebSocket recipient
   resolution, WebSocket delivery, and other effects only after commit.
10. AppInbox owns retrying. Services do not contain inner retry loops. Every
    retry re-enters `read`, then recomputes, revalidates, and attempts a new
    transaction.
11. The default queue policy permits 20 total processing attempts. The first
    five retries use millisecond exponential backoff; later retries use
    increasing seconds with a 30-second cap and jitter.
12. Persisted, queued, event, snapshot, receipt, and response contracts use
    mandatory fields by default. Optional fields require meaningful domain
    absence and explicit consumer tests.

## Scope

The design covers client state, group state, group presence, topology
configuration and override state, topology execution/publication state, and
other api-v1 services reachable from incoming HTTP or WebSocket mutations.

It also covers the shared-server AppInbox, QueueBox, PostgreSQL repository, and
outbox publication surfaces needed to give those mutations one atomic commit.

Read-only HTTP and WebSocket operations do not need AppInbox. Internal
maintenance commands that mutate the same authoritative aggregates must use
the same service operations and transaction discipline even when their initial
trigger is a scheduler rather than incoming network traffic.

## Non-Goals

- Do not place network calls, WebSocket sends, RTC work, topology computation,
  sleeps, or unbounded scans inside a database transaction.
- Do not make one large transaction span AppInbox reservation, pre-transaction
  reads, computation, validation, or retry waiting.
- Do not replace optimistic compare-and-set domain writes with domain row,
  table, or advisory locks.
- Do not promise strict queue fairness. The fairness lane is best effort.
- Do not preserve `StateMutationOutboxWork` merely because an earlier branch or
  implementation plan introduced it.
- Do not call computed persistence data a plan in public APIs, internal types,
  parameters, variables, timing fields, or documentation examples.

## Service Operations

Each mutating service follows this conceptual API:

```ts
type MutatingService<Command, Read, Computed, Result> = Readonly<{
    read(command: Command): Promise<Read>;
    compute(command: Command, read: Read, facts: MutationFacts): Computed;
    validate(command: Command, read: Read, computed: Computed): void;
    write(
        transaction: PSqlTransactionSql,
        computed: Computed
    ): Promise<Result>;
}>;
```

Concrete services may use domain-specific verb names where they are clearer,
but the four responsibilities remain visible. Public operations do not expose
generic nouns such as `executePlan` or `applyPlan`.

### `read`

`read` loads the complete decision surface needed for authorization, policy,
capacity, lifecycle, idempotency, and invariant checks. It executes outside the
write transaction and does not lock domain rows.

### `compute`

`compute` receives a command, the read result, and mandatory immutable facts
such as timestamps, identifiers, and hashes captured once for the command. It
returns fully populated computed data. Given the same inputs, it returns the
same output.

### `validate`

`validate` is pure. It validates both the observed predecessor state and the
computed successor. Hard rejection is reserved for malformed or wrongly scoped
commands, authorization failure, invariant corruption, resource caps, and
terminal lifecycle decisions.

### `write`

`write` receives a `PSqlTransactionSql` created by AppInbox. It constructs all
repositories from that transaction, performs the aggregate compare-and-set
guard as its first authoritative statement, and then writes dependent rows,
events, receipts, and outbox rows. It may use `RETURNING`, but it performs no
domain reread.

A zero-row conditional insert, update, or delete throws the typed optimistic
conflict used by AppInbox retry classification. Any later failure rolls back
the aggregate guard and every dependent write.

## Transaction Utility and Ownership

Add one small shared-server PostgreSQL utility with behavior equivalent to:

```ts
export async function withTransaction<T>(
    database: PSqlSql,
    operation: (transaction: PSqlTransactionSql) => Promise<T>
): Promise<T> {
    return await database.begin(operation);
}
```

The actual name should remain a verb and describe the public operation. The
utility contains no domain logic, retry classification, queue scheduling, or
service lookup. PostgreSQL owns commit and rollback behavior through the
callback result.

AppInbox is the transaction orchestrator:

```ts
const read = await service.read(command);
const computed = service.compute(command, read, facts);
service.validate(command, read, computed);

return await withTransaction(database, async (transaction) => {
    const result = await service.write(transaction, computed);
    await appInbox.writeResult(transaction, entry, result);
    await appInbox.complete(transaction, reservation);
    return result;
});
```

The transaction passed to `service.write`, `ResourceInboxRepository`, the
state/event repositories, the AppInbox result repository, and AppInbox
completion must be the same `PSqlTransactionSql` instance. Constructing several
repositories that each call `begin` does not satisfy this requirement.

The AppInbox reservation remains a preceding short queue transaction. Reads,
computation, and validation then occur without an open transaction. Only the
successful mutation commit includes AppInbox result and completion. When a
write conflict or transient failure rolls the transaction back, QueueBox may
move the reserved row to `RETRY` in a separate short transaction. A crash before
that release leaves a reserved row for the existing timeout recovery lane.

The completion update must condition on the reservation identity, including
the observed attempt or an equivalent mandatory lease token, so an obsolete
worker cannot complete a reservation reclaimed by timeout handling.

## Direct ResourceInbox Outbox

The computed value contains every mandatory fact needed to construct its
outgoing work. During `write`, the service uses a
`ResourceInboxRepository(transaction)` to insert the applicable queue rows:

- `APP_OUTBOX` for topology recomputation, presence-summary work, publication
  work, or other durable server-side effects.
- `WS_OUTBOX` for logical WebSocket state, event, progress, or notification
  delivery.

Immutable outbound effects use a deterministic key derived from the command
identity, aggregate scope, accepted causal revision, effect kind, and payload
kind as needed. Reprocessing the same command produces the same key and
content. Conditional insert is the default:

- absent key: insert the row;
- same key and identical mandatory content: treat as idempotent success;
- same key and different content: report invariant corruption and roll back.

Explicitly coalesced `APP_OUTBOX` work may instead use a stable aggregate/effect
key. Its computed value must include all mandatory generation, causal revision,
reason, due-time, and successor facts. The transaction-bound repository applies
the existing coalescing rule with a conditional write; it must not overwrite a
reserved generation or silently replace equal-generation/different-content
work. Coalescing remains a queue storage policy, not a post-commit
state-mutation materialization layer.

An authoritative mutation does not need to write both queue types. It writes
exactly the effects derived by `compute` and accepted by `validate`.

The service does not wake workers from inside the transaction. After commit,
AppInbox requests a wake. Polling remains the durability fallback if the
process crashes after commit or the wake call fails.

## Removal of StateMutationOutboxWork

The intermediate `state-mutation:outbox` namespace and
`StateMutationOutboxWork` exist only to bridge independently committed domain
state to later QueueBox insertion. Once services can write `resource_inbox`
through the AppInbox-owned transaction, that bridge has no architectural role.

The implementation removes:

- creation of intermediate state-mutation intent records;
- pending-intent scans and delivery CAS state;
- the inner delivery retry loop;
- state-mutation outbox wake wiring;
- tests and exports whose only purpose is the intermediate layer.

Before removal, implementation must inspect the deployed compatibility
boundary. If any supported deployment can contain pending intermediate
records, ship a bounded one-time drain or migration and document the release in
which the compatibility path is removed. If the intermediate implementation
has never been deployed, record that evidence and remove it without a runtime
compatibility path.

## WebSocket Outbox Semantics

`WS_OUTBOX` insertion must not depend on warm in-memory connection state. A
service writes a logical audience with complete scope and causal metadata even
when no recipient is connected to the current process.

After commit, the WS outbox consumer resolves current local or distributed
recipients and attempts delivery. No current recipient is a delivery outcome,
not a reason to omit the atomic outbox row. Reconnect and state refresh remain
eventually consistent recovery paths.

The persisted WS contract must carry mandatory scope, message identity,
accepted causal revision, audience, payload kind, and payload. Receivers accept
newer observations, ignore stale observations, deduplicate equal observations,
and fail closed on equal-revision/different-content corruption.

## Incoming HTTP and WebSocket Mutations

HTTP mutation routes authenticate and normalize the command, capture mandatory
immutable facts, and enqueue one deterministic `APP_INBOX` entry. They wait for
or later retrieve its durable result according to the existing AppInbox API.
They do not call a mutating service directly.

WebSocket transport may continue to use `WS_INBOX` for durable socket ingress.
When a WS message can mutate database state, its handler validates transport
scope and enqueues the corresponding deterministic `APP_INBOX` command. The WS
handler does not call a mutating service directly. Non-mutating WS routing does
not require this extra command hop.

Static and runtime guards should make bypasses difficult:

- route and WS modules depend on AppInbox command APIs rather than mutating
  service instances;
- mutating service `write` operations require a transaction argument;
- service `write` operations cannot obtain the application database implicitly;
- a structural test enumerates mutation routes/topics and proves their AppInbox
  registration.

## Retry Policy

AppInbox and ResourceInbox own retry timing. Services classify failures by
throwing typed errors but never sleep or loop.

The default policy is 20 total processing attempts, including the initial
attempt:

| Processing attempt | Delay before eligibility |
| ------------------ | -----------------------: |
| 1                  |                immediate |
| 2                  |                     1 ms |
| 3                  |                     2 ms |
| 4                  |                     4 ms |
| 5                  |                     8 ms |
| 6                  |                    16 ms |
| 7                  |                      1 s |
| 8                  |                      2 s |
| 9                  |                      4 s |
| 10                 |                      8 s |
| 11                 |                     16 s |
| 12–20              |                 30 s cap |

Apply configurable jitter of 20 percent by default. Inject time and jitter
sources for deterministic tests. `next_ts` is the earliest eligible timestamp;
the design does not promise millisecond execution precision. A nonzero base
delay remains at least one millisecond after rounding. Existing queue circuit
breaking, adaptive concurrency, and rate limiting remain active so the first
five retries cannot create unbounded retry storms.

The policy is configuration data expressed in milliseconds, not a
`Temporal.TimeUnit` exponent. The same utility computes the persisted
`next_ts`, observed delay, and timing diagnostics.

Retryable failures include optimistic conflicts and explicitly classified
transient database or infrastructure errors. Non-retryable outcomes include
malformed commands, wrong scope, authorization and policy denial, invariant
corruption, and terminal lifecycle decisions. An idempotent duplicate returns
the stored result rather than consuming the remaining retry budget.

The HTTP/AppInbox result-wait deadline is independent of the durable processing
budget. Reaching the synchronous wait deadline must not cancel the command or
fall back to a direct service mutation. Preserve the existing externally
visible timeout or pending behavior and correlation identity while the durable
entry remains eligible for later retry and result retrieval.

Every retry starts again at `read`. Authorization, policy, capacity, lifecycle,
idempotency, and invariants are evaluated from current data. Computed data from
a losing predecessor is never reused.

## Best-Effort Fairness Lane

Strict fairness is not promised. Add a separate reservation lane for retryable
entries whose `next_ts` is older than the current time by a configurable stale
threshold. This lane is analogous to reserved-timeout recovery but has a
separate reason, metric, rate limit, and query.

The fairness lane:

- never processes an entry before `next_ts`;
- uses `FOR UPDATE SKIP LOCKED` only for queue claiming;
- respects expiry and maximum-attempt rules;
- has a bounded reservation batch and rate limit;
- records queue age, due age, attempt, and fairness-lane selection;
- does not change domain conflict or authorization semantics.

The existing `(ri_type_id, ri_status, expire_ts, next_ts, ri_row_id)` index must
be verified with the exact fairness query. Add an index only if `EXPLAIN`
evidence shows the existing index is insufficient.

## Failure and Recovery Semantics

| Failure point                                | Required result                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Before mutation transaction                  | No domain or outbox change; reservation is retried or recovered by timeout                 |
| Aggregate CAS conflict                       | Entire transaction rolls back; AppInbox schedules a full-command retry                     |
| Dependent/event/receipt write fails          | Aggregate guard and all writes roll back                                                   |
| `APP_OUTBOX` or `WS_OUTBOX` insert fails     | Domain mutation, event, receipt, result, and completion all roll back                      |
| Result or completion write fails             | Domain mutation and outbound entries roll back                                             |
| Commit succeeds, process crashes before wake | Queue polling discovers committed outbox rows                                              |
| WS has no current route                      | Durable WS entry reaches a no-current-recipient outcome; state refresh/reconnect converges |
| Worker crashes while reserved                | Reserved-timeout lane reclaims it                                                          |
| Retry entry remains overdue                  | Best-effort fairness lane may reclaim it                                                   |
| Attempt 20 fails retryably                   | Entry reaches the configured exhausted/failed state with diagnostics                       |

## Contracts and Mandatory Fields

Commands persisted in `APP_INBOX`, computed mutation values, idempotency
receipts, events, `APP_OUTBOX` work, `WS_OUTBOX` messages, AppInbox results, and
responses use mandatory fields by default. Sparse HTTP bodies, query strings,
patch requests, builders, and migration readers use separate input types.

Optional fields are allowed only when absence is a meaningful domain state,
not as a convenience for partially constructed values. Each approved optional
field requires tests for producers, persistence decoding, and every consumer.
Use discriminated unions or explicit nullable values when they describe the
domain more accurately.

## Observability

Record at least:

- AppInbox queue age, due age, attempt, selected lane, and retry classification;
- `read`, `compute`, `validate`, transaction, and `write` duration;
- CAS conflict and retry-exhaustion counts by service operation;
- transaction SQL statement and affected-row counts in focused performance
  tests;
- numbers of `APP_OUTBOX` and `WS_OUTBOX` rows written per mutation;
- idempotent outbox collision and invariant-corruption counts;
- commit-to-outbox-reservation and commit-to-WS-delivery latency;
- timeout and fairness-lane recovery counts;
- wake requests and polling-based recoveries.

No metric or log field calls computed mutation data a plan.

## Verification

Focused tests must prove:

1. Each HTTP and WebSocket DB mutation reaches its service through AppInbox.
2. `read`, `compute`, and `validate` execute without an open write transaction.
3. Every service `write` receives the AppInbox transaction and never calls
   `begin` itself.
4. State, dependent rows, event, receipt, final outbox rows, result, and inbox
   completion commit together.
5. Failure of each individual write rolls the whole transaction back.
6. `APP_OUTBOX` and `WS_OUTBOX` rows are deterministic and idempotent.
7. A repeated key with different content fails as invariant corruption.
8. A CAS conflict leaves no partial rows and causes AppInbox to rerun the full
   service sequence.
9. Retry delays follow the configured 20-attempt schedule with injected time
   and jitter.
10. Authorization, capacity, lifecycle, and invariants are rerun after a
    conflict.
11. Two api-v1 processes sharing PostgreSQL converge without domain locks.
12. A committed outbox row survives a crash before worker wake-up.
13. WS outbox insertion succeeds without a current local recipient and later
    delivery or refresh converges.
14. Timeout and fairness lanes do not double-commit a mutation; reservation
    identity prevents stale completion.
15. The existing queue index supports the fairness query or measured evidence
    justifies a focused migration.
16. No tracked authoritative contract introduces unjustified optional fields.

The final contention gate retains the existing scale: at least 100
independently authenticated client identities, five shared group aggregates,
ten concurrent client lanes, five concurrent group/topology lanes, and two
api-v1 processes sharing PostgreSQL. Acceptance is deterministic final
convergence, zero lost writes, zero duplicate effects, zero domain lock use,
and no unexpected retry exhaustion.

## Documentation and AI Guidance

Update `AGENTS.md`, `rallar-platform`, `rallar-realtime`,
`rallar-code-writing`, and `rallar-testing` so future AI work cannot treat the
old architecture as precedent. The guidance must state:

- AppInbox is mandatory for incoming DB mutations;
- AppInbox owns the mutation transaction and retry boundary;
- service `write` receives the transaction and never opens one;
- services write final `APP_OUTBOX`/`WS_OUTBOX` rows directly through the
  transaction-bound `ResourceInboxRepository`;
- there is no intermediate state-mutation outbox in this architecture;
- computed persistence data is called `computed`, never a plan;
- retries rerun `read -> compute -> validate -> write` and use the shared
  staged 20-attempt ResourceInbox policy;
- authoritative shared contracts require mandatory fields by default;
- queue locks are coordination-only and are not domain-lock precedent.

Repository docs and historical implementation plans that describe service-owned
transactions, `[0, 2, 8]` inner retries, or `StateMutationOutboxWork` must be
updated, marked superseded, or removed so an AI worker cannot accidentally
restore them.

## Implementation-Plan Requirements

After this specification is reviewed, regenerate the existing implementation
plan under `plans/**`. The revised plan must sequence work so no intermediate
commit leaves direct mutation routes or non-atomic outbox publication as the
documented target architecture.

At minimum it must cover:

1. transaction utility and transaction-bound repository construction;
2. reservation-identity conditional completion;
3. configurable retry schedule and fairness lane;
4. direct transactional `ResourceInboxRepository` outbox writes;
5. client, group, presence, topology, publication, and RTT service conversion;
6. HTTP and WS mutation routing through AppInbox;
7. removal or bounded compatibility drain of state-mutation outbox code;
8. WS logical-audience persistence and post-commit recipient resolution;
9. structural, focused, PostgreSQL concurrency, black-box, and performance
   verification;
10. skills, agent guidance, architecture docs, and historical-plan cleanup.

The revised plan must use `computed` for data produced by `compute`. “Plan” may
appear only when referring to the implementation plan itself.
