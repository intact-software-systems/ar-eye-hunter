# Temporary room archival design

## Intent and delivery boundary

Recent-room navigation can return to an existing room, but an abandoned temporary activity currently
has no idle lifetime. Add an explicit temporary-room policy that hides an empty room from discovery,
allows a bounded opportunity to reconnect, and archives it after continuous observed inactivity.
Persistent social and collaborative rooms remain persistent unless their creator opts in.

This PR delivers automatic archival and its public opt-in. Permanent cleanup is the next independent
retention increment, after archival is merged. Archival denies entry but preserves the room's records;
it must not be described as deletion. The approved seven-day deletion interval is not implemented by
this PR. Its eventual data contract must distinguish room content, application-owned content, audit
events, and replay/idempotency evidence.

The maintainer has delegated planning and implementation of successive slices under the ongoing
goal. The maintainer selected temporary policy for new AR Eye and Relic rooms with ten-minute
reconnect grace and seven-day archived retention before deletion. This increment implements the
creation defaults and archival; the next increment implements deletion after defining the data
contract. Other applications and existing rooms stay persistent unless explicitly opted in.

## Constraints

- Use TDD and one PR, then wait for the maintainer's merge before the next slice.
- Add no legacy path, duplicated implementation, or migration code. Reuse current AppInbox,
  conditional-write, clock, repeating-work, and room-creation owners.
- Every changed human-authored file is reviewed and remediated in full. Support files changed by
  remediation enter the closure recursively. Independent untouched code remains outside it.
- Keep `read -> compute -> validate -> write(transaction, computed)` explicit. AppInbox owns the
  transaction and QueueBox redelivery; one delivery performs one attempt with fresh authority.
- No domain locks and no new group-row write on ordinary presence heartbeats or connects.
- Keep public room admission separate from application activity participation. Archival never resets
  an expedition, starts another match, or promises that an activity is resumable.

## Approaches

The selected engineering approach is opt-in policy plus a bounded server maintenance scan. It uses
the existing group aggregate and per-member presence admissions as optimistic guards. It works
after restart and catches inactivity even when no final browser disconnect is delivered.

Writing an idle deadline on every heartbeat was rejected: presence intentionally has its own guard,
and moving it onto the group aggregate would create a new shared contention point. A browser timer
was rejected because a closed tab cannot own durable retention. A universal empty-room purge was
rejected because emptiness does not imply that a persistent room should cease to exist.

These are engineering rulings under the delegated goal, not separate human-approved decisions.

## Policy and public boundary

Creation accepts an optional retention intent: persistent, or temporary with a reconnect grace.
Temporary grace is a positive safe integer in milliseconds, bounded from 1,000 to 86,400,000; omitted
temporary grace defaults to 600,000 at the documented request boundary. Invalid input is rejected.
Absent intent means persistent. Store the normalized temporary policy in one reserved group metadata
entry, rather than adding a required field to all existing group rows or a second decode path.

The same reserved entry owns its nullable empty-observation fingerprint. The existing
`Group.emptySinceEpochMs` remains the only idle anchor. A complete temporary entry has mandatory
policy and fingerprint fields; malformed present values fail closed as invariant corruption.
Generic metadata replacement preserves this server-owned entry. It cannot opt a room in, opt it out,
or replace the observation. Creation intent is the only policy-setting surface in this increment.
Temporary creation and subsequent updates reject absolute expiry or purge deadlines; their independent
semantics must not shorten reconnect grace. Existing persistent-room deadline behavior remains.
External updates cannot set the idle anchor of a temporary room.

SDK creation exposes the same intent through the existing room/group translation boundary. Discovery
and Quick Join share the policy interpretation: an opted-in temporary room with no currently live
admitted session is hidden even when `includeEmpty` is true. A scoped link or saved reference still
uses normal admission while the room remains active. Listing choice and admission credentials retain
their independent meanings. Policy has no extra visibility effect while an admitted session is live.

## Empty observation and reconnect grace

Empty means no unexpired, connected session belonging to an active member and its exact current
presence admission. Read current group, member, admission, and presence rows at one authoritative
observation; a lagging presence summary cannot authorize archival.

On a live observation, clear any idle anchor and fingerprint. On the first empty observation, store
the attempt's observation time in `emptySinceEpochMs` and a deterministic fingerprint of the observed
member/admission/session identities and revisions. On a changed empty fingerprint, restart grace from
the new observation. Thus a reconnect and disconnect between scans still restarts grace, even if
immutable ingress timestamps predate the previous observation. Cleanup or unrelated roster changes
may conservatively extend grace; they may never shorten it.

With an unchanged empty observation, do nothing before `emptySinceEpochMs + reconnectGraceMs`.
At or after that deadline, compute the archive candidate. An explicit owner/admin archive remains
authoritative; reconnect grace bounds automatic idle archival, not an owner's intentional action.
An already archived/deleted or absent room is a typed
no-op. Pending formation and active gameplay status never substitute for live-session evidence.

The maintenance scan is bounded and restartable. It visits canonical group keys in pages, submits
only temporary active candidates through a separately wired internal capability, and resumes with a
cursor. It uses existing repeating-work lifecycle primitives, does not overlap its own scans, and
stops with the API runtime. It promises no archival before grace expires; maintenance load can delay
archival. No wall-clock performance or maximum cleanup-lag claim is made without measurement.

## Optimistic archival boundary

The group expected-revision update is the first write. It fences metadata, policy, and membership
changes. In the same transaction, archival conditionally fences every active principal's admission:
CAS its observed row, or conditionally insert an empty admission when absent. This catches a new
session in a previously absent slot. Observed presence rows are conditionally deleted at their exact
revisions, so a racing heartbeat cannot extend an expired session behind the archival decision.

If reconnect commits first, one of those guards conflicts and the entire archive attempt rolls back.
If archive commits first, a stale connect conflicts on its admission fence or its presence row and
redelivery rechecks the archived group. Membership writes contend on the group guard; a new principal
cannot appear outside the fenced roster. No-op outcomes do not change state or emit duplicate events.

Persist the archived aggregate, normal group event, compact mutation receipt, exact AppInbox result,
and final outbox intents atomically through the existing owners. Resolve audiences and wake workers
after commit. Keep full scoped identity on maintenance commands; derive request identity canonically
from every semantic command field. Matching replay returns the exact durable result, changed-key
reuse is rejected, and stale maintenance observations cannot shorten a new empty period.

## Validation

Behavior tests cover persistent absence, invalid policy, explicit temporary creation, reserved
metadata ownership, directory/Quick Join hiding, first empty observation, live recovery, between-scan
activity, boundary time, explicit owner archival, and restart after the grace deadline.

Real PGlite and PostgreSQL conditional-write tests race archive with first connect, reconnect,
heartbeat, membership change, metadata update, and a second archiver in both commit orders. Verify
fresh retry, exhaustion, exact replay, changed request reuse, corrupt scoped reads, and rollback of
state/event/receipt/result/outbox on an outbox collision. No lock-order tests substitute for outcomes.

REST creation behavior updates OpenAPI and shared-test recipes. Run focused package tests, native
typechecks, shared-web public API/bundle checks, relevant game tests/builds, the unweakened Postgres
medium-scale gate, and a fresh baseline/candidate state-write performance comparison. PR #701's
performance exception does not apply here. UI adoption, if selected, requires visible-control browser
evidence. Record construction and runtime timelines and the manual 5/5 mutation navigation probe.

## Next two increments

1. This PR: explicit temporary policy, guarded archival, and adoption in both games.
2. After merge: define and implement permanent cleanup seven days after temporary-room archival,
   with its own retained-evidence and application-data contract. Physical deletion is not supplied
   by this first increment.
