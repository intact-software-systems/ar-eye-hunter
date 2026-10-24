# Server application AppInbox

[CounterService](./counter-service.ts) is a non-game application using only
`@shared-server/mod.ts` imports. It increments an existing database counter with
an optimistic revision guard. Missing counters and capacity limits return
explicit durable refusals.

The application owns its table and seed data:

```sql
create table app_counter (
    id text primary key,
    value integer not null check (value >= 0),
    revision integer not null check (revision >= 0)
);
insert into app_counter values ('visits', 0, 0);
```

Register on **every queue claimant**, using the same `appInbox` instance that
`RallarServerApplication` exposes. Construct the database and public capability,
register application operations, construct the server facade with that capability,
and then start the server. Registration is sealed by `rallar.start()` before
workers start.

```ts
import type { PSqlSql, RallarServerApplication, RallarServerRuntime } from '@shared-server/mod.ts';
import { CounterService } from './counter-service.ts';

function installCounters(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>,
    database: PSqlSql
) {
    return new CounterService({ appInbox: rallar.appInbox, database, nowEpochMs: Date.now });
}

// At composition, before rallar.start():
const counters = installCounters(rallar, database);

// An authenticated HTTP boundary supplies a stable caller request ID:
const outcome = await counters.increment.submit({
    counterId: 'visits',
    requestId: requestId,
    capturedAtEpochMs: null
});
```

`submit` waits for the exact durable result. Matching requests replay that result;
a different logical command under the same scoped request key returns an
idempotency failure. `enqueue` returns a bound admission after durable reservation,
and `admission.wait()` waits for its result later. This lets a WS handler finish
after admission without blocking its delivery track on mutation processing.

Before calling an external proposal provider, use `readAdmission(command)`.
Only `undefined` is a validated miss; a retained pending or completed admission
returns immediately, and lifecycle/idempotency failures remain `Either.Left`.
`readReplay(command)` is the completion-waiting convenience. Concurrent misses
may compute separate proposals; only the reservation winner's synchronous
`materialize` captures authoritative immutable facts.

Each delivery runs a fresh `read -> compute -> validate -> commit`. The supplied
write receives AppInbox's transaction. A CAS conflict exits the attempt and
QueueBox redelivery rereads state; the application adds no retry loop. Domain
state and the exact result commit together. Any final outbox rows also belong
in that same transaction, computed before entry. Wake workers or perform other
application effects only after `commit` resolves. The counter has no after-commit
effect; its explicit commit return ends the operation.

The registration's envelope codec owns its canonical data/authority/sender
representation. `toLogicalCommand` excludes captured facts, while `decodeResult`
checks the stored result against the retained winner command. Corrupt stored
bindings fail closed rather than triggering proposal work or a direct write.
