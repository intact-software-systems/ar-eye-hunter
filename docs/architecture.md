# Rallar Architecture

This document records architectural choices that the current code and the
living design notes already make. Each section names the choice and the
alternative that was refused. Longer designs stay in the documents linked
below. Historical implementation plans are not a source for these choices.

## AppInbox owns every incoming database mutation

**AppInbox is mandatory for incoming database mutations**, including all HTTP
and WebSocket client/group/topology, authentication/session/ticket, CRDT
append/admin, and mutating admin paths. AppInbox owns the transaction and retry
boundary. The `read` stage loads the repository decision surface outside the
write transaction. Only `compute` and `validate` are pure, and they produce
computed persistence data, not a plan. Service `write(transaction, computed)`
applies it: service write receives the transaction and never opens or retries
one.

State/event/receipt/result and final `APP_OUTBOX`/`WS_OUTBOX` rows commit in the
same transaction; write final queue rows directly through
`ResourceInboxRepository`. There is no intermediate mutation outbox. Resource
inbox uses 20 total processing attempts, staged from 1, 2, 4, 8, and 16 ms to
seconds capped at 30 seconds with jitter, plus a separate best-effort fairness
lane for retries more than 30 seconds overdue. Queue locks are coordination-only
and authoritative persisted and shared contracts use mandatory fields by default.

The refused alternative is a handler that opens its own transaction and writes
the database directly. That path cannot retry with a fresh authorization check,
and it splits the durable result from the outbox rows that other servers must
observe.

The canonical contract is
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`.
`packages/shared-server/README.md` shows where the server assembles it.
`docs/rallar-convergent-state-and-rtc-topology.md` describes how several API
processes converge group state, client state, and RTC topology on one database.

## Convergence uses causal revisions, not a single writer

Once a record is well formed, convergence is optimistic: read without locking,
calculate outside the transaction, accept newer causal state, ignore older
state, and commit with a short compare-and-set. Duplicate delivery is safe when
the receiver can identify it.

The refused alternatives are a process lock, an aggregate-wide transaction
lock, or one designated writer for topology. Any API server can process the
work and deliver the result to browsers connected to other API servers.
`APP_OUTBOX` stays terminal: topology work does not enqueue another mutation.

## Room in the browser, group-state on the server

`room` is the product and browser term. `group-state` is the authoritative API
and server term. The same `groupId` can exist in different application scopes,
so a bare id is not globally unique. Use `GroupRef` or `roomRef` when scope
matters.

Translation happens only in
`packages/shared-web/browser/rooms/room-group-state-translation.ts`. The
refused alternative is using one word for both sides, or translating inside
each call site. One boundary keeps the protocol identity stable and the browser
API readable.

## Data, CRDT, Motion, and Game stay separate

These are different authorities, not different transports for the same fact.

- Rallar Data stores the latest local value. Using it as match truth was
  refused because a browser can be stale, offline, or behind another client.
- Rallar CRDT merges authored documents. Using it as competitive match
  authority was refused because merge is not a rules engine and peers must not
  decide a winner by converging.
- Rallar Motion interpolates what the user sees. Using it as the simulation
  was refused because smoothing must not move the authoritative position.
- Rallar Game accepts commands and publishes snapshots from the server. The
  refused alternative is letting each browser advance the match and hoping the
  peers agree.

RallarAI stays on the proposal side of the same line. Generated JSON is not
applied until domain code accepts it.

## Which plane carries the fact

Authority and transport are separate choices. The section above says which
owner may decide a fact. This section says which channel carries it. The
recipes are in `docs/rallar-quickstart-and-recipes.md`.

- Room membership, tickets, and durable commands use REST. Recording
  membership on a WebRTC data channel was refused. A data channel is not
  durable, and it is not authorized for every member at the moment of the
  write.
- Chat and other validated room events use a WebSocket topic, as in the "WS
  Chat" recipe. Treating an RTC send as the durable event log was refused.
- Cursors, poses, and other low-latency ephemeral updates use a WebRTC data
  channel, as in the "Realtime Player Updates" recipe. Putting that stream on
  the WebSocket was refused, because the server would fan out data it does not
  need to store.
- `rallar.data` keeps the latest local value. Server app data keeps durable
  application records. CRDT keeps authored documents that merge. Match truth
  is a server command followed by a published snapshot. Peer merge as match
  truth, and Motion smoothing as the simulation, were refused.
  `docs/rallar-motion-guide.md` and `docs/rallar-game-guide.md` say how to use
  the last two.

## Group formation defaults to optimistic and cuts over once

A group created without a `lifecyclePolicy` uses the `optimistic` preset: it is
active at creation, admission stays open, and application data flows. That is
the behavior groups had before the formation layer. Every stricter preset is an
explicit departure, and every enforcement point reads a missing policy as
`optimistic`.

The layer shipped as a hard cutover. Durable rows written before it cannot be
decoded after it. A compatibility reader for the old row shape was refused
because a second decode path would hide which lifecycle is authoritative.
`docs/rallar-group-formation-architecture.md` is the behavior.
`docs/rallar-group-lifecycle-cutover-runbook.md` is the deploy and rollback
order.

Readiness fractions and activation status are observation. They are computed
at read time and are not a second source of membership truth.

## Postgres adapters stay beside the feature

`packages/shared-server/postgres/` keeps the shared SQL port and the
transaction helper. Each feature owns the PostgreSQL adapter for its row shape
and its corruption boundary.

The refused alternative is a general repository bucket that gathers every SQL
file because it uses Postgres. That layout hides which feature a row belongs
to and invites one adapter to write another feature's tables.

## One full browser facade, plus narrow entries

`packages/shared-web/browser/rallar.ts` is the canonical browser object for an
app that uses several Rallar surfaces. Apps that need a smaller bundle use a
narrow entry: `rallar-core.ts`, `rallar-realtime.ts`, `rallar-data.ts`,
`rallar-crdt.ts`, or `rallar-media-calls.ts`.

The refused alternatives are a second aggregate facade, or making feature
controllers import the aggregate entry. Controllers depend inward. Room-scoped
traffic goes through `rallar.realtime.room<T>(...)` or
`rallar.messages.room<T>(...)` rather than hand-wired RTC readiness and sends.
