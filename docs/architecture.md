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
`PSqlResourceInboxRepository`. There is no intermediate mutation outbox. Resource
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

`RallarRoomEntry`, exposed through the narrow `rallar-room-entry.ts` browser
entry, owns the pending destination through authentication and tab reload.
It captures incoming links before startup, gives a newer invitation priority,
removes the code after admission, and fences obsolete account, destination,
and cancellation results. Tab storage records intent; existing server admission
commands decide membership through AppInbox.

Separate per-app restoration and bare-ID saved rooms were refused because they
can replace an invitation with stale or incorrectly scoped state. Both games
consume the shared entry owner and retain their own participation rules.
`examples/browser-startup-room/README.md` shows the browser sequence.

`RallarRecentRooms`, exposed from the same narrow entry, owns device-local history through Rallar
Data. Its store is scoped to the captured principal, application, and workspace. It records only
the ten latest distinct scoped references and visit timestamps after successful entry, with no
credentials or cached claims about access. The owner serializes store lifecycle and local edits;
its pure codec validates persisted history and computes visit/forget changes. Cross-tab history
is latest-value state, so simultaneous edits may replace each other.

History hydration never selects a room. An explicit Return passes the displayed principal to
`RallarRoomEntry.returnTo`; the entry owner rejects stale account/scope selections and runs existing
server admission without a saved code. Forget changes only local history. Storage retry cannot
repeat admission, and neither action enrolls a Relic player or resets an activity. Room expiry,
membership revocation, and retention remain server policy.

## Discovery listing is group policy

Create and update accept sparse `directoryListing` intent and store it in canonical
`Group.metadata.rallarDirectoryListing`. Absence means `listed`; a malformed present value is hidden.
This uses the existing metadata extension map without changing persisted schemas or adding a migration.
Generic metadata replacement preserves the stored listing key; explicit listing intent owns changes.
The server computes from the fresh group read and commits through the existing AppInbox CAS boundary,
so conflict redelivery retains concurrent metadata changes and exact replay retains its original result.

Directory and Quick Join share one listing reader. Hiding invalidates the next conditional directory
read and prevents a stale Quick Join candidate from committing. It does not revoke membership or
presence. A scoped link still enters through ordinary admission. Both games discover public rooms
through scoped safe directory summaries and keep those summaries separate from member snapshots.
Relic paginates and deduplicates directory results, retains visibly stale results after failure, and
fences obsolete request and session responses. Listing is not access control.

## Temporary retention is a separate group-state capability

Creation accepts `retention: { mode: 'temporary', reconnectGraceMs? }` or persistent intent. Absence
means persistent. Temporary grace defaults to 600,000 ms, bounded from 1,000 through 86,400,000 ms.
Canonical temporary state lives in reserved `Group.metadata.rallarRetention`; malformed present state
fails closed. Generic metadata updates preserve it, and temporary rooms reject absolute expiry,
purge deadlines, and externally supplied idle anchors. Existing rows need no migration.

`GroupRetentionService` reads the group, members, admissions, and presence from one authoritative
snapshot. It shares the presence-summary liveness computation, but never trusts a stale summary for
archival. `Group.emptySinceEpochMs` is the only idle clock. A fingerprint of canonical presence,
admission, and member storage revisions detects activity between scans and restarts grace from the
fresh attempt time. The first presence admission also guards the observed group revision; ordinary
heartbeats and reconnects with an existing admission retain their admission-row guard.

The internal `GROUP_RETENTION_RECONCILE` AppInbox registration owns each maintenance attempt. Pure
compute and validate prepare the group CAS, admission fences, exact-revision presence deletes,
event, receipt, and final summary outbox row before transaction entry. AppInbox atomically writes
them with the exact durable result. A conflicting first connect, reconnect, heartbeat, roster change,
or metadata update invalidates the stale archive; QueueBox redelivery rereads fresh authority.
Immutable scoped command identity preserves exact replay and rejects changed request-ID reuse.

Runtime maintenance visits at most 100 physical group keys per minute per API process, advances its
cursor through expired and retired rows, submits active and archived temporary candidates, and drains
on shutdown. Instances
may overlap safely through optimistic writes; scanning and queue load may delay archival. Discovery
and Quick Join hide empty temporary rooms even with `includeEmpty`, while direct entry still uses
normal admission. After 604,800,000 ms from archival, retention deletes observed room children and
room-owned AppData under the same group CAS. The exact group key retains a compact, non-expiring
retired identity so stale writers and later create requests cannot reuse it. Ordinary physically
expired IDs keep their existing recreation behavior. Audit and idempotency/replay evidence retain
their existing lifetime; unrelated application data is untouched.

Relic's server-only mutation owner in `packages/relic-hunters/server` shares that group revision
fence. Every API worker registers `RELIC_GAME_MUTATE` before maintenance starts. Each attempt reads
the current issued session, room policy and save, computes and validates outside the transaction,
then first advances the observed group revision before the save CAS, private publication provenance,
final WS outbox and durable acknowledgement commit together. Expected rule refusals are values;
unexpected failures reach the existing QueueBox retry owner. AI setup proposals are captured before
queue processing. REST commands and resets carry request IDs; replay returns the durable outcome
followed by a fresh authorized snapshot read, so a prior response cannot resurrect a reset or deletion.

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
explicit departure. The create transaction stores the `optimistic` document
when the request names no policy, so enforcement always reads a stored policy;
a missing row fails closed.

The layer shipped as a hard cutover. Durable rows written before it cannot be
decoded after it. A compatibility reader for the old row shape was refused
because a second decode path would hide which lifecycle is authoritative.
`docs/rallar-group-formation-architecture.md` is the behavior.
`docs/rallar-group-lifecycle-cutover-runbook.md` is the deploy and rollback
order.

Readiness fractions and activation status are observation. Neither is a second
source of membership truth. Readiness and remediation are computed at read
time. The activation band is stored on the group and written through AppInbox,
because a band such as `degraded` exists only after a clock has watched the
coverage hold.

## Postgres adapters stay beside the feature

`packages/shared-server/postgres/` keeps the shared SQL port, the transaction
helper, and the `timestamp without time zone` text type. Each feature owns the
PostgreSQL adapter for its row shape and its corruption boundary.

The refused alternative is a general repository bucket that gathers every SQL
file because it uses Postgres. That layout hides which feature a row belongs
to and invites one adapter to write another feature's tables.

## One full browser facade, plus narrow entries

`packages/shared-web/browser/rallar.ts` is the canonical browser object for an
app that uses several Rallar surfaces. Apps that need a smaller bundle use a
narrow entry: `rallar-core.ts`, `rallar-realtime.ts`, `rallar-messages.ts`,
`rallar-data.ts`, `rallar-crdt.ts`, `rallar-media-calls.ts`, or
`rallar-room-entry.ts`.

The refused alternatives are a second aggregate facade, or making feature
controllers import the aggregate entry. Controllers depend inward. Room-scoped
traffic goes through `rallar.realtime.room<T>(...)` or
`rallar.messages.room<T>(...)` rather than hand-wired RTC readiness and sends.
