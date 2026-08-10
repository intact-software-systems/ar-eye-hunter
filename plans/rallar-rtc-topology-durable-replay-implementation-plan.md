# Rallar RTC Topology Durable Replay Implementation Plan

> **For Codex:** Execute this plan with `rallar-repo:publishing-plan-progress`,
> `superpowers:executing-plans`, `superpowers:test-driven-development`,
> `rallar-repo:rallar-realtime`, `rallar-repo:rallar-code-writing`, and
> `rallar-repo:rallar-testing`. Keep the draft PR and this progress record
> current after every meaningful checkpoint.

Status: active; implementation is in progress as the three-PR stack below.

Plan evidence base: `origin/main` was
`726edc7c33386f9282f6594ec4b5c3c02033fbf1` when execution started on
2026-08-09. The latest publication review revalidated `origin/main` at
`0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`; revalidate the checkout, issue,
paths, contracts, and commands before implementation and after every rebase.
Tracking issue: [#121](https://github.com/intact-software-systems/ar-eye-hunter/issues/121).

## Implementation Progress

Current working-tree checkpoint on 2026-08-10:

- `origin/main` advanced to `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`.
  The compatibility review covers the earlier PR #145 changes plus merged PR
  #103's contract-preserving group-topology owner move and additive
  position-balanced benchmark tooling, and PR #144's Hetzner RTC lifecycle
  hardening. The stack overlaps four test/performance paths but no changed
  durable-replay runtime owner; public, transaction, authorization, workload,
  and acceptance contracts remain intact. Because PR #141 is still open at its
  unchanged head, PR 1 remains stacked on that head as required. Its eventual
  rebase must adopt the canonical topology paths and current benchmark tooling
  and invalidate all affected evidence.
- Plan PR [#141](https://github.com/intact-software-systems/ar-eye-hunter/pull/141)
  remains open at `8e277691f3bcd618c556d57ab5ee61cac248f1db`. PR 1 is
  therefore based on that exact head. If #141 merges, PR 1 must be rebased onto
  the resulting `main`, and every affected exact-tree result below becomes stale.
- Issue [#121](https://github.com/intact-software-systems/ar-eye-hunter/issues/121)
  remains open with the live-listener replay/current-state reconnect distinction
  intact. The implementation request selects the plan's Option A contract.
- Code-derived revalidation confirmed the current atomic topology publication and
  `WS_OUTBOX` owner, QueueBox fast path, unused production fanout publish seam,
  transient listener boundary, separate random runtime IDs, WebSocket open
  callback timing, current-state repositories, three-process runner, and existing
  validation commands. The new replay profile and command remain intentionally
  absent until PR 3.
- The untouched PR #141 tree passed `npm run test:unit`: 717 files and 6,562
  tests. Node emitted only its existing experimental `localStorage` warnings.

Stack record:

| Layer | Branch | Base | State |
| --- | --- | --- | --- |
| Plan | `codex/rtc-topology-durable-replay-plan` | `origin/main` | PR #141 open |
| PR 1 | `codex/rtc-topology-durable-replay-1-streams` | PR #141 head | frozen at PR #143 head `871a7c7e` |
| PR 2 | `codex/rtc-topology-durable-replay-2-consumer` | final PR 1 tree | frozen at PR #146 head `43753655` |
| PR 3 | `codex/rtc-topology-durable-replay-3-hydration` | final PR 2 tree | draft PR #148; final evidence pending |

PR 1 is frozen at `871a7c7e9cfdffc3143b3f31d5d6d56d42a58ed4` with
current exact-tree local, black-box, Branch Release Gate, medium-scale, and
governed A-B-B-A evidence. Its schema-first production migration prerequisite
remains an owner deployment action; replay stays disabled through PR 2.

PR 2 is frozen at `43753655015ef3a16c1b7f8039158230f89ebb62`, tree
`1d5aee714dc2d6783c2620fa18318a76994b3d03`, with current exact-tree local,
black-box, Branch Release Gate, and medium-scale evidence. Draft PR
[#146](https://github.com/intact-software-systems/ar-eye-hunter/pull/146)
targets PR 1 explicitly.

PR 3 draft [#148](https://github.com/intact-software-systems/ar-eye-hunter/pull/148)
targets PR 2 explicitly. Its reviewed implementation checkpoint is
`2727de2002e26aa8345a702ff36cd3f95e658ad8`, tree
`66a457fdb0fcbcc415c2afc607869809b04804b8`. This progress-record update will
be the final content change before the exact-tree local, performance, black-box,
and remote gates; every result attached only to the implementation checkpoint
remains pre-freeze evidence.

PR 3 implementation is complete on the working tree. Generation-fenced sends,
strict durable reconnect hydration, enabled replay plus QueueBox, the managed
C-to-C' lifecycle, exact-ID convergence recipe, deterministic N1-N6 passive-C
proof, workflows, docs, and skills are implemented. The fixed reconnect batch
no longer mutates the `Map` it is iterating, preventing a reconnect arriving
during hydration from causing a synchronous loop. Focused proof passes 6 files
and 91 tests plus 7 files and 72 tests; the full RTC topology surface passes 26
files and 393 tests; API Deno passes 420 tests; and true PostgreSQL integration
passes 13 files and 27 tests. Fresh black-box evidence passes memory 13/13,
PostgreSQL 13/13 plus cluster 5/5, CRDT 22/22, medium-scale 2,748/2,748,
formation-large 1,327/1,327, and the standalone A/B/C-to-C' topology replay
proof. The fixed delivery and replay-drain workloads preserve every plan
constant and bound. Pre-freeze repository-wide typecheck, governance, style,
unit, CI, build, and browser-bundle gates passed; subsequent review fixes and
this progress-record edit invalidate those broad results until they are rerun
from the unchanged final tree. Draft publication is complete at PR #148;
the final progress commit, exact-SHA A-B-B-A, and remote exact-SHA gates remain
pending, so PR 3 and this plan remain active.

An independent pre-publication review of the original staged PR 3 tree found
that the profile-only topology command still depended on `clusterOnly` for
database isolation, explicit C shutdown released cleanup ownership before stop
and drain succeeded, in-flight hydration could send after abort, and the proof
did not bind its observations and cumulative metrics to the intended live A/B
entries or C' hydration. TDD now covers and fixes each boundary. Topology replay
profiles always receive a disposable per-run PostgreSQL database while
medium-scale retains its `clusterOnly` requirement; failed explicit stops remain
owned for final cleanup; hydration checks cancellation after every durable read
and immediately before send, resolves its own shutdown abort, and preserves an
external gap abort. The proof first consumes exact baseline hydration, waits
for a stable caught-up baseline, retains AL message identity, requires one exact
publication and one exact HEAD/cursor increment on each distinct A/B publisher,
requires exactly two post-baseline poll-replayed entries, and accepts C' only on
exact current-state hydration identities. Its wire observer now models the
production browser rule by dropping dominated snapshots, retaining monotonic
adoptions, and rejecting equal conflicts or incomparable tuples. The topology
recipe derives the publication presence component from the mutation presence
revision, and one shared behaviorally tested assertion deadline restores the
plan's 10-second bound. Structured failure evidence now wraps every coordinator
phase rather than only live A.

The expanded review-regression set passes 5 files and 36 tests; full workspace
typecheck and strict changed-style review pass. The real profile-only command
also passes against the intentionally reused task PostgreSQL root: it created a
fresh `rallar_bb_*` database, applied all 20 migrations, ran the unchanged
three-process proof, and dropped the isolated database. The credential-free
artifact records baseline publisher HEADs 7/1, exact live A/B publication IDs
and distinct HEADs 8/2, exact replay deltas of two poll wakes, zero notification
or local-commit wakes, and two replayed entries, restart HEADs 9/3, two C'
`rtc-topology-hydration` identities, a new replacement consumer stream, and no
post-start mutation. These review fixes invalidate every earlier broad gate;
the full local, PostgreSQL, black-box, performance, exact-SHA, and publication
sequence must rerun from the final unchanged tree.

PR 1 progress:

- The additive migration, Prisma models, idempotent PGlite mirror, named
  constraints, and bootstrap/invariant proof are implemented. Prisma validation
  and the focused bootstrap suite pass; the migration also deployed cleanly to
  fresh PostgreSQL databases.
- Canonical strict-number contracts, validation, append port, per-process stream
  repository, database-time registration/heartbeat lease, and bounded
  fixed-retention compaction are implemented. Compaction remains active even
  while replay consumption is disabled.
- One process UUID now owns the public publisher ID, QueueBox server suffix, and
  durable publisher stream. Readiness waits for stream registration before
  QueueBox workers start; post-readiness lease loss triggers ordered process
  shutdown.
- Both accepted and loaded topology work paths append or exactly validate the
  durable row in the existing publication/outbox/reservation transaction.
  Same-stream and named uniqueness conflicts retry; lease loss and invariant
  mismatch fail closed.
- Focused proof currently passes: delivery-log/service/outbox/middleware/
  benchmark and source-phase Vitest cases; 58 focused Deno/PGlite cases; three
  true-overlap PostgreSQL cases proving same-stream conflict/rollback,
  independent A/B HEADs, and duplicate-publication loser rollback; root
  typecheck; API check; and changed-style validation.
- Broad working-tree evidence passes: API Deno 415/415; PostgreSQL integration
  25/25; unit 6,582/6,582 across 721 files; repository governance 371/371;
  `test:ci`; all-workspace build; full warning-only style scan; shared-web
  browser-bundle budgets; and `git diff --check`. These results must be rerun or
  confirmed on the final exact PR 1 tree after its evidence record is frozen.
- The fixed delivery-log benchmark passes 300 equal-total appends for one stream
  and three streams, 30 duplicate races, and 100 rollbacks with exact row/HEAD
  counts and contiguous sequences. It lives under `scripts/perf/rtc-topology/`
  because the repository style gate rejected another direct `scripts/perf`
  feature file.
- A preliminary three-run #141/candidate state-write pair had zero correctness
  failures but failed the hot-throughput/noise comparison. It is not exact-tree
  evidence because the candidate was uncommitted. The required pinned,
  nine-run-per-position A-B-B-A evidence remains pending after the final PR 1
  commit.

## Goal

Make committed RTC topology state converge to browsers attached to every live
API process even when that process misses PostgreSQL notifications. Preserve
the existing low-latency QueueBox delivery path, but make notifications wakeups
rather than the only discovery mechanism.

Use a durable publisher stream per API process. Each stream owns its own HEAD,
and each consumer process owns a durable cursor for every publisher stream. A
restarted process gets a new stream identity; its reconnecting browsers receive
the current durable topology rather than a promise that every historical
publication will be replayed.

This implements issue #121 Option A: **live-process replay plus current-state
reconnect hydration**.

## Product Contract

The implemented guarantee is:

1. While process C remains alive and owns open eligible sockets, a topology
   change committed while C's PostgreSQL listener is unavailable is eventually
   discovered from durable storage and converges those sockets without another
   topology mutation.
2. If C terminates, its sockets terminate too. When the same authenticated
   sessions reconnect to replacement process C', C' sends current durable
   topology for every group in which the session is still durably authorized.
3. Duplicate, stale, and cross-stream-reordered work is harmless. The full
   group causal revision plus overlay version decides adoption; a publisher
   sequence is never used as topology authority.

The implementation does **not** promise exact historical event delivery across
browser disconnects, durable per-browser acknowledgements, or a global total
order across API processes. Those stronger contracts would require durable
per-session cursors or browser resume tokens and are outside this issue.

There is no production REST, WebSocket message, browser API, authentication,
or authorization contract change. New schema, runtime configuration,
diagnostics, runner controls, and admin metric fields are internal/additive.

## Confirmed Current Repository Facts

- `RtcTopologyOutboxWork` atomically writes the accepted topology snapshot,
  immutable publication/work claim, fixed-audience `WS_OUTBOX`, and reservation
  completion. It currently has no durable delivery-log append.
- Cross-process delivery is actually owned by `QueueBoxPubSubBridge`: the
  claiming worker sends locally and publishes the durable queue key; remote
  processes load the exact `resource_inbox` row and intersect its immutable
  audience with local sockets.
- PostgreSQL `LISTEN/NOTIFY` is transient. Listener readiness prevents a startup
  race but provides no later anti-entropy.
- `RtcTopologyPublicationFanout` is composed and included in readiness, but
  production never calls its `publish` method. It is not the delivery owner.
- `myServerId` and `myPublisherId` are random on every process start. The
  deployment currently has no stable replica slot.
- A topology publication already contains `groupRef`, the full
  `sourceGroupStateCausalRevision`, `overlayVersion`, immutable recipient
  session IDs, and the exact persisted AL message.
- Browser and server topology decisions compare the group causal pair before
  overlay version. Dominating values advance, dominated values are stale,
  identical equal values are duplicates, and equal/incomparable conflicts are
  explicit.
- `resource_inbox.ri_row_id`, runtime-state key order, and request timestamps
  are not safe commit-order cursors.
- `JsonWebSocketServer` invokes `onConnection` only after the socket opens.
  Reconnect hydration therefore belongs in that lifecycle, not in the HTTP
  upgrade handler.
- The current durable repositories can page all topology snapshots and can
  read exact current group authority. There is no indexed durable
  session-to-group projection.
- The standard Postgres black-box topology is already three Deno processes on
  ports 18080, 18081, and 18082; memory remains one process.

## Decisions Locked By This Plan

1. **Per-process HEADs, not a singleton global allocator.** Every process owns
   one publisher stream and updates only that stream's HEAD. This removes
   cross-process HEAD-row contention. Concurrent streams intentionally have no
   total order.
2. **Ephemeral process identity.** One full UUID identifies the process
   instance, QueueBox publisher, topology publisher stream, and consumer. A
   restart creates a new UUID. Stable deployment slots are not introduced.
3. **Durable cursor per ordered pair.** Cursor `(consumer, publisher)` means
   the highest contiguous sequence from that publisher that the consumer has
   successfully handled.
4. **QueueBox remains the fast path.** Its notification and direct local send
   behavior stay in place. Durable replay is a second discovery path and may
   produce safe duplicates.
5. **Current-state repair is authoritative.** A replay entry identifies a
   committed change and its group. Before repair, the consumer validates the
   referenced publication and outbox row and compares it with the current
   durable topology. Stale or incomparable historical values never override
   current durable state.
6. **Fixed retention, not cursor-pinned retention.** Delivery entries use the
   same explicit 24-hour expiry as their publication and `WS_OUTBOX`. A dead or
   lagging process cannot retain data indefinitely.
7. **Retention gaps recover through current state.** If a cursor falls behind
   the retained prefix, the process hydrates all currently open local sessions
   from current durable topology before advancing to a captured HEAD.
8. **No session projection in this phase.** Reconnect and gap hydration batch
   open sessions, page durable topology snapshots in bounded pages, and perform
   exact durable group authorization only for candidate session/group pairs.
   A topology session projection can be added later if measurements justify
   its schema and migration cost.
9. **Coordinated expand/cutover.** Logging deploys before replay is enabled.
   All log-capable writers must be deployed before consumers are enabled.
10. **Deterministic proof uses a passive node C.** A narrowly scoped internal
    `RALLAR_API_QUEUE_WORKERS=enabled|disabled` setting, default `enabled`, lets
    C host HTTP/WebSocket and replay while A/B own QueueBox processing. It is
    valid only with PostgreSQL. This prevents C from accidentally claiming the
    shared `WS_OUTBOX` and producing false replay evidence.

## A/B/C And N1-N6 Scenario

The black-box proof and documentation use these names consistently:

| API process | Connected browsers | Publisher stream |
| --- | --- | --- |
| A (port 18080) | N1, N2 | A/1, A/2, ... |
| B (port 18081) | N3, N4 | B/1, B/2, ... |
| C (port 18082) | N5, N6 | C/1, C/2, ... |

N1/N3/N5 are three distinct sessions for principal Alice; N2/N4/N6 are
three distinct sessions for principal Bob. This preserves and exercises the
existing same-client/different-session contract while distributing each
principal across all three processes.

Suppose A's HEAD is 10, B's is 20, and C's durable cursors are A=10 and
B=20. A commits A/11 while B commits B/21. C's notification listener is
disabled, so N5/N6 receive neither fast-path notification. C's periodic drain
observes A HEAD=11 and B HEAD=21, reads both missing entries, repairs N5/N6
from current durable topology, then advances its cursors to A=11 and B=21.

A/11 and B/21 are not numerically comparable. C may read either first. The
topology causal pair and overlay version decide which state is current.

When C terminates, N5/N6 terminate with it. Replacement C' has a new stream
identity and seeds its new cursors at the existing HEADs before accepting
traffic. N5/N6 reconnect with the same authenticated session identities and
receive current durable topology through reconnect hydration. C' does not
claim that it historically delivered A/11 or B/21.

## Durable Schema

Add one Prisma migration and mirror it exactly in
`apps/api-v1/src/db/in-memory-schema.sql`.

### `rtc_topology_delivery_stream`

One row per process instance/publisher stream:

| Column | Type | Rules |
| --- | --- | --- |
| `stream_id` | UUID | Primary key; process instance identity |
| `head_sequence` | BIGINT | Non-negative, default 0 |
| `retained_from_sequence` | BIGINT | Positive, default 1; must be `<= head + 1` |
| `lease_expires_at` | TIMESTAMPTZ(3) | Required process lease |
| `created_at` | TIMESTAMPTZ(3) | Database default |
| `updated_at` | TIMESTAMPTZ(3) | Updated on HEAD, floor, or lease change |

HEAD is the last committed sequence in this stream. The retained floor is the
first sequence that may still be read; `head + 1` means the stream currently
has no retained entries.

### `rtc_topology_delivery_log`

One immutable row per committed publication append:

| Column | Type | Rules |
| --- | --- | --- |
| `publisher_stream_id` | UUID | References stream; delete restricted |
| `sequence` | BIGINT | Positive; primary key with publisher stream |
| `application_id` | TEXT | Non-empty |
| `workspace_id` | TEXT | Non-empty |
| `group_id` | TEXT | Non-empty |
| `publication_id` | TEXT | Non-empty |
| `outbox_topic_id` | TEXT | Exact QueueBox key |
| `outbox_resource_id` | TEXT | Exact QueueBox key |
| `outbox_context_id` | TEXT | Exact QueueBox key |
| `retain_until` | TIMESTAMPTZ(3) | Same expiry as publication/outbox |
| `inserted_at` | TIMESTAMPTZ(3) | Database default; diagnostics only |

Primary key: `(publisher_stream_id, sequence)`.

Unique canonical publication identity:
`(application_id, workspace_id, group_id, publication_id)`. This makes a
retry on another process find and validate the winning row rather than append
the publication to a second stream.

Indexes: `(publisher_stream_id, sequence)`, `retain_until`, and the unique
publication identity. Do not add a foreign key to expiring runtime-state or
`resource_inbox` rows.

### `rtc_topology_replay_cursor`

One row per consumer/publisher pair:

| Column | Type | Rules |
| --- | --- | --- |
| `consumer_stream_id` | UUID | References process stream; delete restricted |
| `publisher_stream_id` | UUID | References process stream; delete restricted |
| `last_processed_sequence` | BIGINT | Non-negative |
| `updated_at` | TIMESTAMPTZ(3) | Database time |

Primary key: `(consumer_stream_id, publisher_stream_id)`.

Every BIGINT converted into TypeScript must be a non-negative safe integer.
Exhaustion or malformed values fail closed; no truncation or string/number
coercion is permitted at feature boundaries.

## Publication Append Algorithm

Create a feature-owned append port under
`packages/shared-server/rallar-system/topology/replay/**` and a PostgreSQL
adapter under `packages/shared-server/postgres/rtc-topology/**`. Do not make
the runtime-state publication repository or generic QueueBox own the stream.

`appendOrValidate(transaction, input)` runs inside the existing topology work
transaction:

1. Validate stream ID, canonical `groupRef`, publication, exact outbox key,
   and shared expiry.
2. Look up the unique canonical publication identity.
3. If it exists, require exact semantic equality of group scope, publication
   ID, outbox key, and expiry. Return `existing`; any mismatch is corruption.
4. If absent, read this process's stream HEAD N and require its lease is still
   valid according to database time.
5. Conditionally update only that stream row from N to N+1.
6. Insert immutable log row N+1.
7. Let the surrounding topology transaction commit the topology snapshot,
   publication/work claim, `WS_OUTBOX`, log append, and reservation completion
   together.

The conditional HEAD update and log insert are in one transaction. Rollback
therefore leaves neither a visible HEAD advance nor a sequence hole. Two
workers in one process may conflict on that process's row and re-enter the
existing QueueBox retry boundary. Workers in A and B update different rows and
do not contend on a global allocator.

If two processes race the same canonical publication, one unique insert wins.
The loser rolls back its HEAD update and retries; it then validates the winner.

Integrate the append in both `RtcTopologyOutboxWork` branches:

- new accepted publication: write topology/publication, write/reassert
  `WS_OUTBOX`, append/validate log, finish reservation;
- loaded work claim: reassert `WS_OUTBOX`, append/validate the already accepted
  publication, finish reservation.

The handler calls process-local QueueBox and replay wake functions only after
commit. A failed wake never changes durable acceptance.

## Process Registration, Lease, And Readiness

Expose one runtime identity in `apps/api-v1/src/runtime/runtime-identity.ts`:

```ts
export const myProcessInstanceId = crypto.randomUUID();
export const myPublisherId = myProcessInstanceId;
export const myRtcTopologyStreamId = myProcessInstanceId;
```

The aliases make existing QueueBox identity compatible while documenting one
process owner.

Defaults, defined in one replay-policy module:

- publisher/consumer heartbeat: 10 seconds;
- lease duration: 30 seconds;
- anti-entropy poll: 1 second;
- page size: 100 entries;
- maximum drain work per turn: 10 pages / 1,000 entries;
- compaction interval: 60 seconds;
- reconnect batching window: 25 milliseconds;
- publication/log retention: existing 24 hours.

At startup, before HTTP or QueueBox workers start:

1. Insert this process's stream with HEAD 0 and a database-time lease. A UUID
   collision or conflicting existing row fails readiness.
2. Capture all existing publisher HEADs and retained floors.
3. Seed this new consumer's cursors to those captured HEADs. There are no
   surviving sockets from an earlier process, so historical replay is neither
   useful nor claimed.
4. Start the single-flight replay loop, heartbeat, and compactor.
5. Combine stream registration/replay readiness with the existing QueueBox
   listener readiness. `main.ts` must not serve before the combined barrier.

A publisher stream first discovered after readiness is seeded to
`retained_from_sequence - 1`, not HEAD, so a live consumer cannot skip entries
from a newly started producer.

Lease renewal uses database time. Lease loss is a typed health failure. The
process stops replay, closes its local sockets, and initiates controlled
shutdown rather than continuing to claim work without a valid lease; reconnect
elsewhere invokes current-state hydration. A process must never silently create
a replacement cursor under the same identity.

## Bounded Replay Drain

Use one process-local single-flight scheduler. Notification, local commit,
startup, and periodic poll only request a drain; they do not create overlapping
drainers.

For each turn:

1. Discover publisher streams, including lease-expired streams that still have
   retained entries.
2. Rotate the starting stream to provide round-robin fairness.
3. Capture each selected stream's HEAD and retained floor.
4. Read the consumer cursor.
5. If the cursor precedes the retained floor, run gap recovery.
6. Otherwise page strictly after the cursor and no later than the captured
   HEAD. Require exact contiguous sequences.
7. Stop after 100 entries per page and 1,000 entries per turn, then yield and
   reschedule if work remains.

Reject `cursor > HEAD`, a retained floor outside `[1, HEAD + 1]`, and a
missing cursor for this still-leased consumer as corruption. Only initial
startup and first discovery of a new publisher may create cursor rows.

For every log row:

1. Load and strictly validate the exact scoped publication.
2. Load the exact `resource_inbox` `WS_OUTBOX` by its recorded key and require
   its immutable message, audience, group, causal revision, and expiry to agree
   with the publication/log row.
3. Load current durable topology for the row's group.
4. If the log publication is exactly current, deliver the immutable outbox
   message to current local targets.
5. If current durable topology dominates the historical publication, or the
   tuples are incomparable, materialize a direct current-state repair and send
   that instead. The stored current topology is authoritative; do not guess an
   ordering between streams.
6. A publication that appears to dominate current durable topology, an equal
   tuple with different content, missing data before expiry, wrong scope, or
   mismatched key is corruption. Stop that stream and leave its cursor
   unchanged.

Capture database time once per page for expiry decisions. If a referenced
publication/outbox disappears after its shared `retain_until`, switch to the
typed retention-gap recovery path. A reference missing before that database
time is corruption and must not be skipped.

Use `WsQueueBoxServerService.sendToTargetsWithResult` for immutable replay
delivery. No local recipient is successful handling because future sockets
hydrate. Any live send failure stops at the contiguous successful predecessor.
Advance the cursor with compare-and-set only after that predecessor has been
handled. Crash before cursor CAS repeats safe work; CAS can never acknowledge
an unprocessed entry.

The existing QueueBox listener remains the low-latency direct path. Extend its
validated topology-key receive seam with an optional wake callback, but do not
move topology policy into generic QueueBox code.

## Retention, Gaps, And Compaction

Compaction is feature-owned and bounded. It is not a new public admin-prune
category.

For each publisher stream, a compaction transaction:

1. starts at `retained_from_sequence`;
2. identifies at most 1,000 contiguous expired entries;
3. rejects an unexplained physical hole;
4. deletes that contiguous prefix;
5. advances `retained_from_sequence` to the first retained sequence in the
   same transaction.

Consumer cursors never pin the fixed retention window. Cursor rows for a
consumer whose lease has been expired for more than the retention window may
be removed. A stream row may be removed only after its lease is expired, its
log is empty (`retained_from_sequence = head_sequence + 1`), and no cursor
references remain. Foreign keys use restrict, never cascade durable evidence.

When `cursor + 1 < retained_from_sequence`, exact historical groups are no
longer knowable. Gap recovery therefore:

1. captures the publisher HEAD;
2. captures all currently open local connection contexts;
3. performs the same bounded durable current-state hydration used on reconnect;
4. advances that publisher cursor to the captured HEAD only after hydration
   succeeds for every still-current captured connection;
5. leaves the cursor unchanged and retries after any failure.

New connections arriving during the sweep use their own reconnect hydration;
publications after the captured HEAD remain replayable normally.

## Reconnect Hydration And Authorization

Create a focused reconnect hydrator owned by the topology feature. Register it
with `JsonWebSocketServer.onWebsocketCallbacksDo` and start work only from
`onConnection`, after the socket is open.

The hydrator batches connection contexts for 25 ms, pages durable topology
snapshots 100 at a time, and yields between pages. For every snapshot whose
`activeSessionIds` contains a pending session:

1. read the current group snapshot from the **durable** `GroupStateRepository`,
   not a process cache;
2. require the authenticated principal to have current active membership and
   require that exact session to be active, unexpired, and owned by the same
   principal;
3. reload/validate current durable topology if the group moved during the
   authorization read;
4. materialize a current-state `overlay.topology` message targeted only to the
   session;
5. send only if the captured `ConnectionContext` is still the current open
   generation.

Add an identity-based encoded-send helper to `JsonWebSocketServer`; checking by
session ID and then calling the existing ID-based send is racy because a
replacement generation can occupy the same ID between those operations.

Transient read/send failure keeps the context in the hydrator's bounded retry
queue while that exact generation remains open. Delays rise to 30 seconds and
continue until success or connection replacement/close. Authorization absence
is a successful skip, not a retry. Never send topology from stale cache state
and never treat hydration as authority for later RTC messages; existing strict
message authorization remains unchanged.

Hydration messages are direct, non-persisted current-state messages with a
deterministic identity derived from the captured connection generation and
topology causal tuple, a fixed one-session audience, and the normal topology
expiry. Duplicate hydration remains harmless to the browser causal cache.

## Diagnostics And Operations

Add a feature-owned optional `RtcTopologyReplayDiagnosticsSink` and process
local aggregate metrics. Include the aggregate under the existing admin
`rtcTopology` metrics object; resetting the existing `rtc-topology` category
resets planning and replay metrics together.

Bounded event dimensions:

- wake source: `startup | notification | local-commit | poll`;
- drain outcome: `caught-up | yielded | failed | lease-lost`;
- entry outcome: `delivered | current-repair | no-local-recipient | send-failed
  | corrupt`;
- cursor outcome: `advanced | conflict | gap`;
- hydration outcome: `sent | unauthorized | no-topology | retry | stale-generation`.

Aggregate counts/durations include drain attempts/completions/failures, pages,
entries, direct current repairs, no-recipient handling, send failures, cursor
conflicts, gaps, corrupt references, hydration outcomes, total duration, and
maximum observed lag in entries. Do not use application, workspace, principal,
group, session, publication, process-instance, request, or stream IDs as metric
labels. IDs may appear only in access-controlled diagnostic logs when needed to
repair corruption and must not be copied into metrics artifacts.

Readiness must expose replay registration/lease failure through the existing
health barrier. Update troubleshooting guidance with SQL-safe inspection for
HEAD, retained floor, cursor lag, lease expiry, and stalled corruption without
publishing secrets or tenant identifiers.

## Configuration And Rollback

Add strict parsers and startup logs for:

- `RALLAR_RTC_TOPOLOGY_REPLAY=disabled|enabled`;
- `RALLAR_API_QUEUE_WORKERS=enabled|disabled`.

The final default is replay `enabled` and queue workers `enabled`. Logging is
always on after the schema expansion, even when replay consumption is disabled.
Queue-worker-disabled mode is valid only with PostgreSQL and is used by the
dedicated proof node C; ordinary local, CI, and deployment processes retain
enabled workers.

Rollback levels:

1. Set replay to `disabled`: durable appends and QueueBox fast-path delivery
   continue; publisher registration, lease renewal, and fixed-retention
   compaction continue; replay consumption and reconnect hydration stop.
2. Roll application code back to the write-only release: additive tables remain
   and direct QueueBox behavior continues.
3. Roll back before schema removal only after all log-capable application code
   is gone. Do not drop tables as part of an emergency application rollback.

## Stacked Implementation Sequence

Implement as three stacked PRs. Every PR is based on the final predecessor tree
and gets its own focused/local evidence. Merge and deploy in order.

### PR 1 — Durable streams and atomic publication append

Purpose: additive schema and write-only expansion. Replay remains disabled.

- [x] Add migration, Prisma schema models, PGlite mirror, SQL constraints, and
      schema/bootstrap tests.
- [x] Add canonical contracts, safe BIGINT codec, validation, append port, and
      `PSqlRtcTopologyDeliveryRepository`.
- [x] Consolidate runtime identity around `myProcessInstanceId` and register the
      process stream before QueueBox startup.
- [x] Add stream heartbeat/lease ownership needed by writers.
- [x] Add bounded fixed-retention log compaction so write-only deployments and
      rollback mode do not grow the new tables without limit.
- [x] Integrate `appendOrValidate` in both accepted and loaded
      `RtcTopologyOutboxWork` transaction paths.
- [x] Map HEAD/unique conflicts into the existing retry boundary; map invariant
      mismatch and exhausted sequence into typed fail-closed corruption.
- [x] Add unit, PGlite, and true-overlap PostgreSQL tests for gap-free sequence,
      rollback, same-stream conflict, independent A/B appends, duplicate
      publication races, exact outbox identity, expiry, and lease loss.
- [x] Capture baseline/candidate state-write performance evidence.

Mixed-version rule: apply schema first, then deploy PR 1 everywhere. Old
writers may omit log rows during this expansion, so replay remains disabled.
The direct QueueBox path is unchanged.

### PR 2 — Live replay, cursors, retirement, and diagnostics

Purpose: implement the consumer while retaining a disabled default until all
writers are log-capable.

- [x] Add durable cursor seed/read/CAS, stream discovery, page reads, consumer
      retirement, and final empty-stream retirement methods.
- [x] Implement the pure page-continuity/current-state decision core and the
      stateful single-flight replay shell.
- [x] Wire notification/local-commit wakeups without moving policy into
      QueueBox.
- [x] Add fixed-retention gap recovery and coordinate it with the PR 1
      compactor's retained floor.
- [x] Add replay diagnostics and compose them into existing admin RTC topology
      metrics/reset.
- [x] Add strict replay and queue-worker configuration; keep replay default
      disabled in this PR.
- [x] Add process lifecycle shutdown for poll, heartbeat, compaction, and
      in-flight drains.
- [x] Add repository/service tests for bounded/fair drain, duplicate wake,
      stale/current/incomparable handling, partial send failure, cursor retry,
      no-recipient success, gap recovery, corruption stall, lease loss, and
      compaction boundaries.
- [x] Add PostgreSQL integration tests with A/B publisher streams and a live C
      consumer whose notification wake is absent.

Deployment rule: deploy PR 2 everywhere with replay disabled. Confirm all
running versions append logs before cutover. No historical log backfill is
claimed or required because the cutover/restart hydration establishes current
state, not historical event delivery.

### PR 3 — Reconnect hydration, deterministic black-box proof, cutover, docs

Purpose: close restart semantics, enable the feature, and publish proof.

- [x] Add identity-fenced encoded send to `JsonWebSocketServer` with replacement
      generation race tests.
- [x] Implement batched/paged reconnect and gap hydration with strict durable
      group authorization and current-topology revalidation.
- [x] Register hydration at socket `onConnection`; add shutdown/cancellation and
      bounded retry behavior.
- [x] Add queue-worker-disabled API mode, default enabled, and validate it is
      PostgreSQL-only.
- [x] Add a managed A/B/C proof coordinator and N1-N6 scenario under
      `packages/shared-test/black-box-runner/topology-replay/**`.
- [x] Extend managed process lifecycle with explicit stop/restart controls and
      non-overwriting restart logs.
- [x] Add `api-v1-black-box-topology-replay` runner profile and
      `npm run test:api-v1:black-box:postgres:topology-replay`.
- [x] Run node C with PostgreSQL notifications and QueueBox workers disabled;
      assert post-open A/B mutations reach N5/N6 only through replay.
- [x] Stop C, mutate through A/B, restart C' with a new process identity,
      reconnect N5/N6 using the same authenticated sessions and fresh one-use
      tickets, and assert current topology arrives without a post-restart
      mutation.
- [x] Preserve standard memory, Postgres, CRDT, medium-scale, and
      formation-large workload constants and profiles.
- [x] Wire the proof command and all four server logs (A, B, C, C' restart) into
      API-v1 Black-Box, Release Gate/Branch Release Gate, and failure artifacts.
- [x] Change replay default to enabled only after PR 1 and PR 2 are fully
      deployed.
- [x] Remove `RtcTopologyPublicationFanout` from production composition,
      readiness, handler options, and api-v1 transport ownership. Preserve its
      existing `@shared-server` public export as deprecated compatibility data
      unless a separately approved breaking release removes it.
- [x] Update active docs and skills; do not rewrite historical
      `docs/superpowers/**` records.

## Planned File Ownership

Exact paths may move only when current repository evidence proves a renamed
canonical owner; record the change in plan progress.

New feature files:

- `packages/shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-delivery-validation.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-delivery-append-port.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-replay-policy.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-replay-drain.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-reconnect-hydrator.ts`
- `packages/shared-server/rallar-system/topology/replay/rtc-topology-replay-diagnostics.ts`
- `packages/shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts`
- `packages/shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-replay-proof.mts`
- `scripts/perf/rtc-topology/delivery-log-bench.ts`

Primary integrations:

- `apps/api-v1/prisma/schema.prisma` and a new migration;
- `apps/api-v1/src/db/in-memory-schema.sql`;
- `apps/api-v1/src/runtime/runtime-identity.ts`;
- `apps/api-v1/src/middleware.ts`, `create-rallar-server.ts`, and `main.ts`;
- `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`;
- `packages/shared-server/rallar-system/ws-system-topics.ts`;
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`;
- `packages/shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts`;
- `packages/shared/websocket/JsonWebSocketServer.ts`;
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`;
- managed API-v1 black-box runner/options/lifecycle, recipe matrix, scripts, and
  workflow governance tests.

Active guidance updates:

- `docs/rallar-convergent-state-and-rtc-topology.md`;
- `docs/rallar-troubleshooting-checklist.md`;
- `packages/shared-server/README.md` and the topology feature navigation map;
- `packages/shared-test/black-box-runner/tests/README.md`;
- `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`;
- `.agents/skills/rallar-realtime/SKILL.md`;
- `.agents/skills/rallar-testing/SKILL.md` and
  `.agents/skills/rallar-testing/references/test-commands.md`;
- `.agents/skills/performance-analysis/SKILL.md` if benchmark routing changes.

## Required Proof

### Repository and unit proof

- Stream registration, lease renewal, lease loss, and retirement.
- HEAD starts at zero; first append is one; committed sequences are contiguous.
- Transaction rollback leaves no HEAD advance or log row.
- Same-stream concurrent append retries; independent A/B stream appends do not
  share a mutable row.
- Same publication raced from A/B produces one canonical row and rolls the
  losing HEAD back.
- Existing append validates exact scope, key, expiry, and immutable content.
- Page bounds, captured HEAD, continuity, safe BIGINT conversion, and cursor
  CAS.
- Successful prefix plus later failure advances only to the predecessor.
- Crash-before-CAS repeat and direct-plus-replay duplicate are harmless.
- Current dominates historical, historical appears to dominate current,
  equal-content duplicate, equal-content conflict, and incomparable cases.
- No local recipients advances; live send failure does not over-acknowledge.
- Retained-prefix compaction, gap recovery, corrupt/missing reference stall,
  and expired-process cleanup.
- Reconnect authorization, active/expired/disconnected presence, membership
  revocation, generation replacement, close during read, batched scan, and
  retry cancellation.

### API-v1 Deno proof

- Prisma/PGlite schema parity and bootstrap.
- Replay/queue-worker config parser matrix and production-env hardening.
- Combined readiness refuses stream registration/listener/lease failure.
- Standard startup still starts QueueBox; passive C skips it only in explicitly
  configured PostgreSQL mode.
- `ws-routes`/WebSocket lifecycle starts hydration after open and never sends to
  a replacement generation.
- Middleware composition has one topology delivery owner and no required
  `publicationFanout` dependency.

### Three-process proof

The dedicated coordinator must make all evidence semantic, not log-count-only:

1. A/B/C ready within the existing 10-second assertion.
2. N1/N2 attach to A, N3/N4 to B, N5/N6 to passive C.
3. Post-open topology mutations enter through both A and B.
4. C has notifications disabled and no QueueBox workers.
5. N5/N6 receive the corresponding current causal revisions before another
   mutation; C diagnostics record poll-driven replay.
6. Duplicate drain/wake evidence produces no topology regression or duplicate
   RTC lane assertion.
7. C stops; A/B commit a later topology; C' restarts with a distinct process
   identity.
8. N5/N6 reconnect as the same authenticated sessions and receive the latest
   durable causal revision without any mutation after C' starts.
9. A, B, C, and C' logs are isolated; cleanup leaves no managed process.

Keep the existing medium-scale constants unchanged: 100 independently
authenticated clients, five groups, three API processes, 10 client lanes plus
five control lanes, and all current assertions.

## Traceability Matrix

| Guarantee | Implementation owner | Required evidence |
| --- | --- | --- |
| A/B writes do not contend on one HEAD | per-process stream repository | true-overlap PostgreSQL test and delivery-log benchmark |
| A committed append has no visible hole | append transaction | rollback/commit-order repository tests |
| One publication appears in one stream | canonical unique identity | A/B race test and exact existing-row validation |
| Missed notification is repaired live | replay poll/drain | passive-C N1-N6 black-box proof |
| Restart converges current state | reconnect hydrator | C/C' same-session proof |
| Cursor never over-acknowledges | contiguous handling plus CAS | partial failure and crash-before-CAS tests |
| Cross-stream order is not authority | current topology causal comparison | A/B reverse-order and incomparable tests |
| Duplicate delivery is harmless | immutable message plus monotonic browser cache | direct+replay duplicate tests and black-box assertion |
| Retention is bounded | fixed expiry/compactor | compaction and retired-consumer tests |
| Retention gap is observable and repairable | gap hydration | gap sweep success/failure tests |
| Reconnect does not authorize from cache | durable group repository | revoked/expired/wrong-principal hydration tests |
| Replacement socket is not written | context identity fence | generation race tests |
| Corruption is not skipped | strict row/reference validation | missing/mismatched publication/outbox tests |
| Readiness covers replay ownership | combined startup barrier | Deno readiness failure tests |
| Diagnostics have bounded dimensions | replay sink/metrics | exact event union and forbidden-label tests |
| Public contracts remain compatible | preserved exports/wire shapes | public API snapshots, Swagger, bundle/governance tests |

## Performance Evidence

The topology publication transaction gains one process-local HEAD CAS and one
immutable insert. This changes a production transaction/concurrency domain, so
performance evidence is required.

1. Run `npm run perf:api-v1:state-write` against an unmodified baseline and the
   candidate using the documented A-B-B-A pooling method when local variance
   requires it. Compare with
   `scripts/perf/compare-api-v1-state-write-results.mjs`.
2. Add `scripts/perf/rtc-topology/delivery-log-bench.ts` with fixed workloads:
   one stream versus three streams, equal total appends, same-stream contention,
   independent-stream concurrency, duplicate publication race, and rollback.
   Record throughput, p50/p95/p99, transaction retries, row counts, and
   contiguous-sequence verification under `tmp/perf/`.
3. Record replay drain operation counts for caught-up, 100-entry, 1,000-entry,
   no-recipient, current-repair, and gap-hydration cases. Page/turn limits are
   acceptance criteria; no numeric latency SLO is introduced in this phase.
4. Rerun the existing topology star and formation-large workloads as regression
   evidence; do not claim they measure durable replay persistence.

Generated profiles and database contents are not committed. Commit only a
concise measured-results record if repository policy requires it for the
implementation PR.

## Validation Commands

Focused commands are selected from the current `rallar-testing` skill and must
be corrected if paths/scripts change before implementation.

```sh
npx vitest run \
  packages/tests/shared-server/rtc-topology-delivery-log.test.ts \
  packages/tests/shared-server/rtc-topology-replay-service.test.ts \
  packages/tests/shared-server/rtc-topology-reconnect-hydrator.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/queuebox-pubsub-bridge.test.ts \
  packages/tests/shared/websocket-json-server.test.ts

npx vitest run \
  packages/tests/shared-test/api-v1-black-box-run.test.ts \
  packages/tests/shared-test/api-v1-managed-server-plan-lifecycle.test.ts \
  packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts \
  packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts \
  packages/tests/repo/api-v1-black-box-workflow.test.ts

cd apps/api-v1 && deno task check && deno task test
```

Run database and black-box proof with a freshly migrated isolated test
database. Preserve the database service's initial stopped/running state.

```sh
npm run test:postgres:integration
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:crdt
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:formation-large
npm run test:api-v1:black-box:postgres:topology-replay
```

After final code/docs/skill edits, run from the unchanged final tree:

```sh
npm run test:repo-governance
npm run check:repo-style
npm run test:unit
npm run test:ci
npm run build
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
git diff --check
```

Record passed, failed, and skipped commands. A failure in the mandatory local
three-process proof blocks workflow/document cutover; preserve artifacts and
classify startup, readiness, append, replay, transport, assertion, cleanup, or
infrastructure before changing code. Do not increase timeouts, reduce page
proof, or shrink workloads to make the test pass.

## Publication And Completion Gates

For every stacked PR:

1. Record its exact base SHA, final commit SHA, Git tree, focused results, local
   completion gates, and known deviations in this plan's progress notes.
2. Keep a draft PR current while work continues.
3. Require **Branch Release Gate** on the exact final SHA. A rebase or content
   change invalidates prior evidence.

PR 3 additionally requires **API v1 Medium-Scale Gate** and the new topology
replay proof on the same exact SHA. Merge only in stack order and only after the
operational write-only deployment prerequisites are satisfied.

After each separately authorized default-branch integration, record the
resulting full SHA and require the normal Release Gate plus **Run Hetzner
Supported Distributed Manifests** on that exact SHA. The plan is not complete
while any required command/workflow is pending, skipped, failed, or attached to
an older tree.

Close issue #121 only after:

- all standard writers append process-stream log entries;
- replay is enabled and passive-C local proof passes;
- C/C' reconnect hydration proof passes;
- fixed retention, gaps, corruption, and lease retirement are tested;
- active docs and skills describe per-process HEADs and cursors correctly;
- exact-SHA local/remote gates are recorded.

## Deliberately Deferred Work And Residual Risks

- Exact historical publication delivery across browser disconnects and durable
  per-session acknowledgements remain deferred.
- A durable session-to-topology projection remains deferred. Reconnect cost is
  a bounded paged scan, batched across simultaneous reconnects; diagnostics and
  measurements determine whether a projection earns its migration cost.
- There is no global total order. Debugging must identify entries as A/11,
  B/21, and so on rather than comparing bare sequence numbers.
- The 24-hour loss window remains explicit. A process offline past retention
  receives current-state repair, not missing event history.
- QueueBox notification delivery remains best-effort and may duplicate replay.
- Browser client/group deletion tombstones, REST collection floors, durable
  invalidation replay for other state, and topology formation damping remain
  separate work.
- Removing the deprecated public `RtcTopologyClusterTransport` export requires
  a separately approved compatibility change.
