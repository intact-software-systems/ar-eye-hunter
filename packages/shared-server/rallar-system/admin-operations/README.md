# Admin operations ownership

`AdminOperationsService` is the package facade for administrator reads, process-local metric reset,
and mutation delegation. It does not own topology or CRDT mutation policy: the mutation gateway
delegates those requests to their canonical domain AppInbox services.

Expired-data pruning is the authoritative database mutation owned by this feature:

1. `inbox/app-admin-inbox-service.ts` normalizes semantic intent and derives the scoped AppInbox
   identity from the caller, request ID, and app-data scope.
2. `inbox/admin-prune-command-codec.ts` owns the initial durable command. Only the winning AppInbox
   reservation captures time, expiry, job identity, and other volatile facts.
3. The AppInbox attempt rereads current administrator authority and expired-row counts, computes and
   validates the initial result, then atomically stores the aggregate and first APP_OUTBOX page for
   each category. A committed non-dry-run attempt wakes the queue.
4. `prune/admin-prune-page-codec.ts` owns the later APP_OUTBOX page protocol.
5. `prune/admin-prune-page-worker.ts` rereads the candidate page, aggregate predecessor, current
   authority, and clock facts. It computes and validates one page before opening one fenced write
   transaction.
6. `postgres/admin-operations/p-sql-admin-prune-repository.ts` compare-and-swaps aggregate progress,
   conditionally deletes the exact selected keys at the captured cutoff, inserts an optional
   successor page, and completes the reservation in that transaction. The worker wakes the queue
   only after commit.
7. `prune/admin-prune-progress.ts` converts a completed aggregate into the exact durable result that
   the AppInbox caller returns.

Equal requests replay or wait for the stored result. A different semantic intent at the same scoped
identity fails with `idempotency-conflict`. Authentication and current administrator authorization
are checked before replay disclosure. The exact historical topic
`app-inbox.admin-operations` remains a narrow persisted-row decoder; there is no general legacy
fallback or alternate reservation system.
