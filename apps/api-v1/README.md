# Rallar Server API V1

`apps/api-v1` is the generic Rallar Server shell. It owns auth, rooms, presence/lifecycle, dynamic
WS topics, RTC signaling/topology, CRDT, app data, and route mounting. It should not become a
concrete game server.

## Database Mutation Ownership

**AppInbox is mandatory for incoming database mutations.** Every HTTP and
WebSocket database mutation uses it, including client/group/topology,
authentication/session/ticket, CRDT append/admin, and mutating admin operations.
AppInbox owns the transaction and retry boundary; waiting for a synchronous
result never falls back to direct mutation.

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

The `read` phase loads the repository decision surface outside the write
transaction. Only `compute` and `validate` are pure. Computed persistence data
is not called a plan. The service `write(transaction, computed)` applies it:
service write receives the transaction and never opens, commits, replaces, or
retries one. It writes final `APP_OUTBOX` and `WS_OUTBOX` rows directly through
`ResourceInboxRepository` in the same transaction as state, event, receipt, and
result. There is no intermediate mutation outbox. Logical WebSocket audience
resolution happens only after commit; queue workers are then woken or poll.

Resource inbox allows 20 total processing attempts: 1, 2, 4, 8, and 16 ms for
attempts one through five, increasing seconds capped at 30 seconds with jitter,
and a separate best-effort fairness lane for retries more than 30 seconds
overdue. Queue locks are coordination-only. Domain row, table, advisory, and
CRDT document locks are not queue-claim exceptions. Authoritative persisted and
shared contracts use mandatory fields by default.

## Production Hardening

Set `RALLAR_PRODUCTION_HARDENING=1` or `ENVIRONMENT=prod` to make startup fail closed when
production-only guardrails are missing. The hardened profile requires Postgres, exact HTTPS CORS
origins, strict state read authorization, admin-only registration,
`AUTH_STATIC_CLIENTS_MODE=disabled`, a stable `RALLAR_AUTH_CREDENTIAL_SECRET` of at least 32
characters, Metered TURN, and explicit black-box operator-token settings when control tokens are
brokered.

See [Production Env Hardening Checklist](../../docs/production-env-hardening-checklist.md) and
[Environment Variables](../../docs/environment-variables.md).

## REST snapshot point reads

Client point reads accept one optional canonical non-negative safe-integer
`minStateRevision`. Group point reads accept `minGroupRevision` and
`minPresenceRevision` only as a complete pair. Malformed floors return typed
`400` responses; authorized durable shortfall or causal incomparability returns
typed `409 state-revision-floor-not-satisfied`. Repeated floor conflicts do not
trip the infrastructure circuit breaker.

Tokenless point reads observe durable current state. Eligible tokened reads may
use a presence-fresh cache entry that satisfies the requested floor, while
strict authorization always uses durable state. Group policy, floor validation,
and the successful response reuse one durable snapshot. Graph and topology
authority reads also use one durable current snapshot per request; mutation
prechecks remain advisory because AppInbox revalidates before commit.

Successful point responses use `Cache-Control: no-store` and authoritative
source and revision headers. CORS exposes those Rallar headers. Client response
metadata carries one scalar revision; group metadata carries the group and
presence revisions, while the compatibility scalar revision remains body-only.
See [the API reference](../../docs/rallar-api-reference.md) for exact paths,
headers, status codes, and OpenAPI shapes.

## RTC persisted-state cutover

The RTC persisted-state migration is an offline cutover. It intentionally has no legacy dual-read
runtime fallback.

1. Stop every API process and old writer that can mutate RTC topology/runtime state, then take and
   verify a database backup.
2. Inspect the fixed migration order without opening a database connection:
   `deno task rtc:migrate-persisted-state --old-writers-stopped --dry-run`.
3. With writers still stopped, run `deno task rtc:migrate-persisted-state --old-writers-stopped`.
   The explicit acknowledgement is required before the operator opens a connection. The command
   first invalidates every legacy scalar topology dependency family and writes a deterministic
   durable recompute request in the same conditional transaction. It then migrates snapshot keys,
   then publication/claim keys, stopping on the first error.
4. Restart only the current API version and verify startup cleanup and RTC topology traffic before
   restoring normal service. Startup drains the durable recompute requests into idempotent topology
   work. The owned single-flight worker retries transient failures and polls while the process is
   live; a failed enqueue leaves its request durable for both autonomous retry and restart recovery.
   A successful enqueue is acknowledged with compare-and-set deletion, making exact deterministic
   replays safe.

Rollback: if migration or verification fails, keep writers stopped, preserve the failed database for
investigation, restore the pre-cutover backup, and restart the previous API version. Do not roll
back by enabling mixed old/new writers or a runtime legacy-read path.

## Rallar Game

Browser-director games use the normal Rallar browser facade. `api-v1` already provides the needed
server primitives for rooms, director state, WS, RTC, and relay support; no Rallar Game topics are
installed by default.

Server-authoritative games opt in with Rallar Game Authority through the existing `.ws` facade. The
game owns simulation, command legality, payload validation, persistence, scoring, AI, and rendering.

Use room-scoped topic IDs such as `room.cash-chase.authority`. The dynamic WS router intentionally
supports user topics under `app.*` and `room.*`; `game.*` is not a supported namespace.

```ts
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';
import { createRallarServer } from './src/create-rallar-server.ts';

const rallar = createRallarServer();

installRallarGameAuthorityServer<
  CashChaseCommand,
  CashChaseSnapshot,
  CashChaseEvent
>({
  rallar,
  protocol: 'cash-chase.authority.v1',
  topicId: 'room.cash-chase.authority',
  handleCommand: cashChaseService.handleCommand,
  readSnapshot: cashChaseService.readSnapshot,
});

rallar.system.useDefaultMiddlewareTopics().useWebSocketLifecycle();
rallar.ws.mount(app);
rallar.rest.mount(app);
rallar.start();
```
