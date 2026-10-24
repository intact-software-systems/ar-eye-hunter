# Server Authoritative Game

Game commands enter `rallar.appInbox` through authenticated REST or a validated
WS topic. A game-owned service reads current authority and state, computes and
validates the full candidate, then writes state, publication intent and the
exact durable acknowledgement in one AppInbox transaction.

[RelicGameInboxService](../../packages/relic-hunters/server/relic-game-inbox-service.ts)
is the concrete consumer. It registers `app:relic-hunters:mutate` through the
public `RallarServerAppInbox` capability. Every API claimant registers it on the
same instance exposed by `RallarServerApplication.appInbox` before workers start;
[API composition](../../apps/api-v1/src/composition/create-api-v1-relic-services.ts)
shows that dependency order.

```ts
import { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import type { RelicGameMutationService } from '@relic-hunters/server/relic-game-mutation-service.ts';
import type { RallarServerApplication, RallarServerRuntime } from '@shared-server/mod.ts';

function installGameMutations(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>,
    service: RelicGameMutationService
) {
    return new RelicGameInboxService({
        appInbox: rallar.appInbox,
        service,
        wakeQueue: () => rallar.runtime.qboxEngine.wake()
    }, { serviceId: 'game-worker', serverPeerId: rallar.ws.serverPeerId, nowEpochMs: Date.now });
}
```

Call this during composition before `rallar.start()`. The game owner keeps:

- issued-session and current room-policy authorization on every attempt;
- command identity and schema checks, and proposal validation;
- a validated retained-admission check before any external AI proposal;
- winner-only immutable fact capture, with no provider call in the reservation;
- the observed group revision fence, save CAS and publication policy;
- command-bound durable-result decoding and a fresh authorized snapshot read
  after the acknowledgement.

[The mutation service](../../packages/relic-hunters/server/relic-game-mutation-service.ts)
exposes `read -> compute -> validate -> write(transaction, computed)`.
`appInbox.commit(context, result, write)` supplies the transaction and persists
completion atomically. A conflict exits to outer QueueBox redelivery, which
starts again with a fresh read. There is no game-owned queue or retry loop.

REST waits for completion. WS handlers await durable admission and return; they
do not hold an ordered delivery track while the mutation worker runs. A matching
pending replay returns the retained admission immediately. AppInbox later runs
the operation, and committed outbox rows carry room snapshots and private hunter
events. Queue wakes occur after commit; live audience resolution uses committed
authority.

The durable Relic envelope is canonical: `data` holds the logical command,
`authority` holds the captured ingress, and `senderId` is the actor session.
Retained rows use that same decoder. Replay returns the original acknowledgement,
then the REST boundary reads current state so an old acknowledgement cannot
resurrect a reset or deleted expedition.

For the transport boundary, see
[RelicHunterGameService](../../apps/relic-hunter-server-v1/src/relic-game-service.ts).
For a smaller non-game public-import example, see
[Server application AppInbox](../server-app-inbox/README.md). High-rate pose and
input presentation can still use room RTC lanes with authoritative snapshot
reconciliation.
