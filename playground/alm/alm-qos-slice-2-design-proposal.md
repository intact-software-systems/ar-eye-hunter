# ALM publication QoS Slice 2 design proposal: authorized WS pub/sub (S2-i, S2-ii)

Release 9, Slice 2 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) §7, after
Slice 1 closed with S1-ii (#736, `cc629d767`). Written from four read-only surveys of `main` at `cc629d767`
(group-state governance and persistence; WS topics, admission and audience; the browser surface and the
conformance harness; api-v1 routes, OpenAPI and black-box recipes) and the maintainer's rulings S2-R1–S2-R9 of
2026-10-29, each taken on its recommended option, with the controller's routine choices for the REST shapes,
the declared initial grant, the presence-summary work and the topic bound. Slice 2 lands as two pull requests
(S2-R1): **S2-i**, publication grants and their enforcement on every WS path, and **S2-ii**, session
subscriptions, the audience intersection, the browser topic roles and the four-role proof. Decisions are
D483–D501 in the roadmap's decision record, entered at S2-i's close; D492–D501 (§3.1) are design choices made
under the rulings, accepted by the controller, D499 ruled by the maintainer as S2-R10. "As applied" notes are added at each close. This file is
deleted with S2-ii's close.

## 1. The problem and the scope

The addendum asks for directed data flow inside a scoped group: exact `GroupRef` × principal × topic grants
managed by owners and admins, session subscriptions, an audience that is the intersection of membership, grant,
subscription and targeting, and WS enforcement on every path (§3.1–§3.3, §5.1–§5.2). Today none of it exists:

- There is no publication permission. `GroupRole` is `owner | admin | member | spectator`
  (`packages/shared/api/group-types.ts:23`), `GroupMember` carries no permission field (`:148-207`), and the only
  data-plane rule is that a spectator cannot send application data
  (`packages/shared-server/rallar-system/group-state/policy/group-message-policy.ts:80-82`).
- Every room publication reaches every live session of every active member: `toAuthorizedRoomAudience` is
  active members ∩ live sessions ∩ targeting ∩ leader
  (`packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts:168-187`). A topic declares no
  participation (`websocket/router/rallar-server-ws-router-contracts.ts:91-97, 151-154`), and its `authorize`
  is a boolean that sees only the sender.
- After `route` hands a message to the outbox, nothing rechecks authority. Dequeue reads the captured policy only
  (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts:79-121`), repair keeps
  to the captured audience (`ws-queue-box-server-outbound-planning.ts:240-285`), and the cluster bridge's
  `filterEligibleCapturedSessionIds` hook (`packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts:85-87, 528-540`)
  is wired by api-v1 only with the socket/scope eligibility filter (`apps/api-v1/src/composition/create-api-v1-runtime.ts:551-556`
  passes `filterEligibleDurableWsSessionIds`), which reads no grant.
- A server publish is implicitly trusted: `createServerPublishRoomAudienceReader` applies no sender policy
  (`websocket/read-server-publish-room-audience.ts:13-23`), and a proxy's transformed message is re-authorized
  without its target topic's definition (`websocket/router/rallar-server-ws-publication-audience.ts:33-40`).
- A browser "subscription" is a local listener set keyed `topicId/typeId`
  (`packages/shared-web/browser/messages/browser-rallar-message-subscriptions.ts:32-46`,
  `messages/rallar-message-selectors.ts:24-28`); nothing remote is subscribed.

**Scope.** S2-i makes grants an authoritative group-state fact and enforces them on WS: the store, the grant and
revoke commands, the snapshot, delta and event, the topic opt-in, one pure admission function on every WS path
(client ingress, replay, dispatch, `route`, server producer, proxy, and the per-attempt re-check at dequeue,
retry, repair and awaited sends), the browser channel's `access` and its send-time refusal, REST with OpenAPI and
recipes, and the docs. Its audience on a granted topic is every live session whose principal holds `subscribe`.
S2-ii narrows that audience to sessions that subscribed: leased session subscriptions, the subscribe and
unsubscribe commands, the intersection, the browser topic roles and subscribe API, and the four-role family.

**What this slice does not do.**

- **RTC parity.** A granted topic is `unsupported` over RTC (S2-R9); an authenticated original publisher, relay
  versus application permission and RTC fallback/repair parity are Slice 3, the addendum's first later outcome.
- **Ordered subscription entry.** No start position, snapshot/live handoff or omission evidence; a granted topic
  that asks for ordering keeps today's per-sender tracks, and a subscriber joining mid-stream gets no replay.
- **Confidentiality.** Grants decide application delivery, not byte access; relays and the server see payloads.
- **Consumer groups, offline replay, processing acknowledgements.** A receipt stays protocol-admission evidence;
  `exclusive` ownership stays a sending session's claim.
- **Wildcards or implicit grants.** No group-wide or future-topic grant, no grant on an implicit topic, no
  inference from admin status, no admission-time default grant for joiners (a carry, §6.4).

## 2. What exists and is reused (facts, with the surveys' locations)

`GS` = `packages/shared-server/rallar-system/group-state`; `WS` = `packages/shared-server/rallar-system/websocket`.

- **Group-state is JSON rows in `runtime_state_store`** (`apps/api-v1/prisma/schema.prisma:29-40`), the row
  `revision` the CAS token. Namespaces are `group-state:groups|members|sessions|presence-summaries|presence-admissions|idempotent`
  (`GS/persistence/group-state-runtime-namespaces.ts:1-6`); a child key is `<groupKey>:<part>=<value>`, decoded
  at arity 4 by `decodeGroupStateChildStorageKey` (`GS/persistence/aggregate/group-aggregate-storage-keys.ts:48-63`).
  Exact-key decoders reject any added field: `validateStoredGroup` (`GS/persistence/validate-persisted-group.ts:93-125`),
  the public twin (`packages/shared/api/authoritative-state-validation.ts:116, 419-420`) and the delta twin
  (`packages/shared/api/group-state-delta.ts:30-60`).
- **Revisions.** `snapshotVersion` is `causalRevision.groupRevision`; `rosterVersion` is bumped only by
  `computeGroupMembershipWrite`, whose guard is `{ kind: 'group', operation: 'update', expectedRevision }`
  (`GS/mutation/write/compute-group-membership-write.ts:36-58`). The WS authorizer honours a sender's
  `rosterVersion` floor with `not-yet-in-sync` (`WS/ws-topic-room-authorizer.ts:263-271`).
- **The AppInbox cycle in group-state.** `readResultFacts` outside the transaction, then pure `compute`,
  `validate` (recompute and compare), and `write(transaction, computed)` with the guard first
  (`GS/inbox/group-state-inbox-handler.ts:108-171, 240-281`; `GS/mutation/write/write-group-mutation.ts:14-42`).
  A guard miss throws `runtime-state-write-conflict`, a retryable code (`packages/shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts:46-52`),
  so AppInbox rolls back and redelivers with fresh authorization. A computed `no-op` or `rejected` outcome is a
  value (`GS/mutation/group-mutation-contracts.ts:613-635`). Every caller aggregate command shares the
  `${groupKey}:aggregate` exclusion key (`GS/inbox/to-group-command-exclusion-key.ts:26-55`), so a grant and a ban
  of one group compute one after the other.
- **Governance.** `canGovernGroupMember` (`GS/policy/group-governance-policy.ts:54-89`): the actor is an active
  owner or admin; an admin governs regular members only, its own row included; actions are
  `invite | remove | ban | unban | promote | demote | transfer-ownership` (`:18-25`).
- **One new command touches ~29 production and ~15 test registries** (survey table), including the
  `toDescriptorCommand` classifier whose `default:` routes any unlisted operation to the membership translator
  (`GS/group-mutation-authority.ts:269-298`), the retirement namespace list (`GS/persistence/read-group-retirement-entries.ts:32-62`),
  the route-pattern registry in `packages/tests/shared-test/api-v1-recipe-idempotency-cutover.test.ts` and the
  event policy `GROUP_PUBLIC_RESULT_EVENT_POLICY` with its `allowsNoOp`
  (`packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-group-causal-evidence.ts:12-56`).
- **Authority freshness is a durable per-read version probe.** `readCurrentSnapshot` is
  `GroupStateCurrentSnapshotCache` (`GS/snapshot/group-state-current-snapshot-cache.ts:24-78`): each read issues one
  revision probe over exactly the snapshot rows (`GS/persistence/read-group-state-authority.ts:88-114, 147-175`) and
  serves a kept value only while the versions match and no shown lease has lapsed. The 60 s TTL
  `GroupStateSnapshotReadThroughCache` (`GS/snapshot/group-state-snapshot-read-through-cache.ts:24`) also exists and
  must never decide a grant.
- **Browser deltas come only from the presence-summary worker.** A write with `presenceSummaryWork: 'none'`
  mints no summary row and so no delta (`GS/mutation/group-mutation-result.ts:389-412`); with `'enqueue'` the
  worker also mints topology work whose input fingerprint covers session ids, display name, leader and config only
  (`packages/shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts:70-93`).
- **The WS passes.** One router-installed authorizer runs at socket admission, pending replay, inbox dispatch and
  `route` (`WS/router/rallar-server-ws-router.ts:183-279`); the audience is frozen at socket admission as
  `source.groupRecipientPeerIds` (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:688-713`)
  and only narrowed afterwards; refusals map to `ALMessageRejection` codes and `ALNackReason`s
  (`router/rallar-server-ws-router.ts:298-358`; `packages/shared/al-contracts/al-control.ts:29-42`). Implicit
  `app.*`/`room.*` topics are routable by default (`router/rallar-server-ws-router.ts:494-497`).
- **The exclusive-send template.** An exclusive send goes over WS under every strategy but `rtc`, whose carrier
  refuses it `unsupported` (`packages/shared-web/browser/messages/browser-rallar-message-sender.ts:253-266`;
  `packages/shared/multicast/compute-rtc-exclusive-refusal.ts:12-26`).
- **Sessions.** One WS per auth session; a newer socket replaces the older with `connection-replaced`
  (`packages/shared/websocket/json-web-socket-server.ts:138-146`). Presence rows carry `connectionGenerationId`,
  and cleanup closes only its own generation's rows (`GS/presence/group-session-cleanup.ts:14-35`). Heartbeat
  every 20 s (`packages/shared-web/browser/session/browser-session-heartbeat.ts:27`), lease 120 s
  (`session/refresh-state-heartbeat.ts:26`).
- **REST shape.** One `registerXxxRoute` per route, ~24 lines, path `requestId` only (20–128 `[A-Za-z0-9_-]`),
  the response the full `GroupSnapshot` (`apps/api-v1/src/group-state/register-group-membership-routes.ts:148-177`;
  `packages/shared/api/mutation/api-mutation-request.ts:3-23`). The admission pair
  `admissions/{principalId}/grant|decline` is the naming precedent
  (`apps/api-v1/src/group-state/register-group-admission-routes.ts:230-295`). `CreateGroupRequest` takes sparse
  creation intents normalized at the boundary (`packages/shared/api/state-types.ts:82-99`).

## 3. Decisions

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                               | Cost if wrong                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D483 | **S2-R1, two pull requests.** S2-i: the grant store; the grant and revoke commands with REST, OpenAPI and the declared initial grant; `publicationGrants` on the snapshot and its delta with the `publication-grant-changed` event; the topic opt-in; one pure admission function on every WS path, the server producer and the proxy included; the per-attempt re-check at dequeue; the browser channel's `access` and send-time refusal; the recipes; the medium-scale Postgres gate; the docs. S2-ii: persisted leased session subscriptions; the subscribe and unsubscribe REST pair; the audience intersection; the browser topic roles and subscribe API; the four-role local family; the docs (2026-10-29).                                                                           | Grants are the authority and are enforced before any consumer API relies on them; subscriptions only choose which eligible sessions receive, so they land on a proven grant boundary. Each pull request is reviewable alone.                                                                      | Between the two, a granted topic reaches every subscribe-granted session whether or not it subscribed; no product topic is `granted` before S2-ii, so nothing observes it.                                           |
| D484 | **S2-R2, the grant store.** A child namespace `group-state:publication-grants` beside `group-state:members`, key `<groupKey>:grant=<principalId>`, one complete row per principal with exact-topic permission sets `{ [topicId]: { publish, subscribe } }`. A grant write compares-and-sets the group row and bumps `snapshotVersion` only, never `rosterVersion` or `metadataVersion`, so no roster floor trips and no replan is commanded. The grant prefix joins the snapshot's version-probed selectors and the one-statement mutation read. Absence means no rights; there is no migration. At most 64 topics per principal; the 65th is refused `capacity`.                                                                                                                            | A per-principal row matches the member lifetime (one delete at departure), reads as one prefix selector at arity 4, and avoids a `GroupMember` field (three exact-key decoders, OpenAPI, a backfill and ~96 literal sites). The probed selectors give revocation freshness with no new machinery. | A change rewrites the principal's whole row (≤ 64 entries); a browser that needs a grants-only floor later needs a `publicationVersion` on the group row (a carry).                                                  |
| D485 | **S2-R3, lifetime.** Leave (self `upsertMember` to `left`), remove and ban delete the principal's row in the same guarded batch; a rejoin needs a fresh grant, and unban lands on `left` with none. Retirement deletes the rows. Archive, expiry and status `deleted` keep the row and every enforcement fails closed. A spectator may hold `subscribe`, never `publish`. An owner may grant itself; an admin may not (`canGovernGroupMember` as is).                                                                                                                                                                                                                                                                                                                                        | Deleting at departure makes "a rejoin cannot resurrect a grant" structural. Rows kept on soft states are harmless, because the active-group rule denies before any grant is read.                                                                                                                 | A rejoining principal loses grants an operator expected to keep and is re-granted with one command; the opposite error, a resurrected grant, is the one the addendum forbids.                                        |
| D486 | **S2-R4, the topic opt-in.** The WS topic definition declares a required `participation: 'members' \| 'granted'`; only `granted` topics enforce grants, and such a topic is always a defined topic (an implicit `app.*`/`room.*` topic is `members`). The browser typed channel mirrors it as `access: 'members' \| 'granted'`, validated at channel creation; a send on a `granted` channel without the publish role is refused at the send.                                                                                                                                                                                                                                                                                                                                                | An explicit per-topic opt-in is the addendum's posture (no wildcard, no guessing from a missing field) and keeps every existing topic's behaviour.                                                                                                                                                | Every topic and channel definition names its participation: five production topic installers, five production channel owners and their tests. A browser and a server that disagree are settled by the server's NACK. |
| D487 | **S2-R5, enforcement.** One pure `computeRoomPublicationAdmission(input) → Either<Refusal, Audience>` over the snapshot (grants at the probed version), the topic's participation, the publisher as a session or a server producer, the targeting and `now`. The existing room authorizer calls it on every pass, and the server-publish audience reader calls it for server and proxy publishes. Server producers get an explicit per-topic publication capability. Freshness is durable authority as of the version probe at each admission and dispatch step, failing closed when unknown. Outbox dequeue, retry and repair re-check through the existing `filterEligibleCapturedSessionIds` hook, now wired. The receipt keeps a revoked recipient as an unconfirmed expected recipient. | One function on every path is the addendum's "one scoped policy and path inventory"; the probe is already durable-current per read (#675).                                                                                                                                                        | A path the inventory misses bypasses grants. §6.1 enumerates the paths, and a granted topic on any unfrozen resolver path is refused, not resolved.                                                                  |
| D488 | **S2-R6, exposure.** `publicationGrants` on the public `GroupSnapshot` and its delta; one new `GroupEventType`, `publication-grant-changed` (principal, topic, permissions, actor), written by grant and revoke; readback is the existing group read. The two exact-shape validators and the delta codec change in S2-i.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Grants are low-churn group facts, and the browser already learns group facts from snapshots and deltas; no second read surface is needed.                                                                                                                                                         | Every snapshot reader changes at once: validators, OpenAPI, shared-web fixtures, the public API snapshots and the bundle budgets. The change is additive and mandatory.                                              |
| D489 | **S2-R7, subscriptions (S2-ii).** Rows in `runtime_state_store` beside presence, `group-state:subscriptions`, keyed group + session + topic, with `connectionGenerationId`, a subscription generation, a lease (20 s renew, 120 s) and the authority it was admitted under. Idempotent AppInbox REST subscribe and unsubscribe under `.../groups/{groupId}/sessions/{sessionId}/...` with a self-session guard. Outside `GroupSnapshot` and `causalRevision`; read at admission through the version probe. Only the asserting generation removes a row (the multi-tab rule); separate sessions of one principal are independent. The browser channel's `subscribe(handler)` returns a token per call, ref-counted locally and re-asserted on socket reopen.                                  | A grant says who may; a subscription says which session currently elects to. Subscription churn kept out of the causal revision cannot bump the roster, raise send floors or replan.                                                                                                              | Leases cost renew traffic per held subscription; a stale generation can hold interest for at most one lease.                                                                                                         |
| D490 | **S2-R8, browser names (S2-ii).** `RallarRoomTopicRole` = `'publisher' \| 'subscriber' \| 'publisher-subscriber' \| 'none'`; `RallarRoomMember.topicGrants`; `RallarRoomSession.topicRole(topicId)`; admin `rooms.grantTopic(member, topic, { publish, subscribe })` and `rooms.revokeTopic`, on the `setMemberRole` workflow; the channel's `access`. Public API snapshots and budgets follow.                                                                                                                                                                                                                                                                                                                                                                                              | `participation` (player/spectator) and `publication` (pacing) are taken; "topic role" names the derived fact and never collides with `GroupRole`.                                                                                                                                                 | A rename after release breaks app code; the names are fixed now.                                                                                                                                                     |
| D491 | **S2-R9, RTC and proof.** A granted topic is typed `unsupported` over RTC: its sends go over WS under every strategy except `rtc`, which is refused at the send (the exclusive-send template). Proof: REST recipes for grant, revoke, subscribe and unsubscribe (readback, idempotency, conflict, no-grant denial) and the medium-scale Postgres gate (S2-i); a local four-role family (two producers, two consumers, one of them a sibling session of a producer's principal) proving subscribe, revoke during a held dispatch, and reconnect with a new generation over `ws` and `rtc-with-ws-fallback` (S2-ii); a hosted four-agent manifest only for the parts that share no principal, as guidance. RTC publisher and subscriber parity is Slice 3.                                     | RTC cannot yet prove an original publisher across relays (§5.3); routing before the RTC leg means no fallback can carry a restricted send. Local lanes are the gate (hosted results are guidance).                                                                                                | An app on `rtc` cannot use a granted topic until Slice 3, and a granted topic pays WS latency under `rtc-with-ws-fallback`.                                                                                          |

### 3.1 Design choices under the rulings (D492–D501)

| #    | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                              | Cost if wrong                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D492 | **Grant and revoke semantics.** Both take `{ topicId, publish, subscribe }` with at least one `true`. Grant adds the named permissions; revoke removes them. An entry with both false leaves the row, and an empty row is deleted. A command that changes nothing is a `no-op`: receipt only, no event, no version bump (`allowsNoOp: true`).                                                                                                                                              | Symmetric and idempotent by effect: a retry or a duplicate intent with a new `requestId` converges, and "revoke subscribe only" needs no read-modify-write by the caller.                                                                                                                                        | A caller wanting "set exactly" sends a grant and a revoke; a later `set` command is additive.                                         |
| D493 | **Presence-summary work is `'enqueue'` for a grant-only write.** D488's delta is built only by the summary worker, so `'none'` would leave browsers stale until their 20 s refresh. The minted topology work is a no-op: the fingerprint excludes grants, and a unit test pins it unchanged.                                                                                                                                                                                               | The routine line allows `'enqueue'` when it is forced, provided the fingerprint is a verified no-op. It supersedes the routine line's `'none'`.                                                                                                                                                                  | One topology work row per grant write (grants are low-churn); if the planner ever folds a grant into its input, the pin fails first.  |
| D494 | **The declared initial grant is the creator's.** `CreateGroupRequest.publicationGrants?` is the creator's own `{ [topicId]: { publish, subscribe } }`, normalized at the boundary into its row at create; absence means none. A default for later joiners is a carry.                                                                                                                                                                                                                      | The creator is the only principal at create; a joiner default needs a persisted declaration and its own lifetime rule, which no ruling settles.                                                                                                                                                                  | A single-feed group grants each joiner explicitly until the admission default lands.                                                  |
| D495 | **The `capacity` refusal.** `GROUP_POLICY_REASON_CODES` gains `'capacity'`, with `details: { limit: 'topics-per-principal', max: 64 }`, as a 403 policy denial, mirroring ALM's `capacity` plus `limit` (D477).                                                                                                                                                                                                                                                                            | One refusal name across ALM and group-state, with the limit named.                                                                                                                                                                                                                                               | The code is unqualified among qualified siblings; renaming it is a one-line contract change before release.                           |
| D496 | **Server-producer capability.** A `granted` topic definition names `serverProducerIds: readonly string[]` (possibly empty); `publish(input)` names `producerId`. A server publish on a granted topic whose definition does not list the producer is refused `topic-not-granted`.                                                                                                                                                                                                           | Visible construction: the capability is declared where the topic is, at the composition root, and a producer never impersonates a member.                                                                                                                                                                        | A producer added later needs a definition change, which is intended.                                                                  |
| D497 | **Proxy authority.** A proxy rule's transformed message is admitted on the original sender session's grant for the result topic, with the result topic's definition passed in; a rule needing server authority publishes as a producer.                                                                                                                                                                                                                                                    | A rule cannot widen its sender's rights (§5.1: "re-authorizes the result's topic and scope").                                                                                                                                                                                                                    | A rule that relays from a subscriber-only member onto a granted topic is refused; that is the protection.                             |
| D498 | **The re-check port.** `filterEligibleCapturedSessionIds` becomes asynchronous and is wired by api-v1 over the probed snapshot and `computeRoomPublicationAdmission`. The same port narrows the captured audience at single-instance dequeue (`readDequeueAuthority`), repair planning and the awaited-connection hold (`ws-queue-box-server-service.ts:740-760`), for granted topics.                                                                                                     | The hook exists but is synchronous (`queue-box-pub-sub-bridge.ts:85-87`), covers only the cluster bridge and today composes only the socket/scope eligibility filter; the port composes that filter with the grant filter, a probed read is asynchronous, and the single-instance paths need the same narrowing. | One probe per outbox attempt on granted topics (the state-write gate measures it); `members` topics keep today's behaviour (a carry). |
| D499 | **api-v1 declares granted topics from configuration.** `ApiV1Configuration` gains `grantedWsTopics` (each `{ topicId, typeId?, fanout, serverProducerIds }`, decoded at the boundary, empty by default), installed with `defineTopic({ participation: 'granted', scope: 'room', ... })` beside the CRDT topics. The black-box and Playwright profiles configure one topic.                                                                                                                 | **Maintainer ruling S2-R10, 2026-10-29.** api-v1 is the generic shell and defines no app topics, yet recipes and the S2-ii lane need a granted topic on the real server; configuration is a product surface, not test wiring.                                                                                    | Without it, WS enforcement is proven only by service tests that call `defineTopic` directly.                                          |
| D500 | **The browser channel.** `access` is required on every typed channel definition (the room-session string binding fills `'members'`); `'granted'` requires an explicit `topicId`. On a granted channel, `sendRtc`, a `send` with `strategy: 'rtc'` and `onRtc` are refused `unsupported`; the send-time check reads the room's cached snapshot and settles `rejected` with `refused`/`no-publish-grant` before any leg; with no cached snapshot the send goes to the server, which decides. | Mirrors the required server field; the local check is advisory and never replaces the server.                                                                                                                                                                                                                    | A stale cache refuses a just-granted send until its delta lands (pushed; bounded by the 20 s refresh).                                |
| D501 | **Effective permissions.** `resolveGroupPublicationPermissions(snapshot, principalId, topicId)` returns both false for a non-active member and `publish: false` for a spectator, whatever the row says. A grant with `publish: true` to a spectator is refused `forbidden-role`; a later demotion keeps the row.                                                                                                                                                                           | One pure reader for the server, the browser and the facade; the spectator rule holds even across role changes.                                                                                                                                                                                                   | The row and the effective permission can differ for a demoted principal, and the facade reports the effective one.                    |

## 4. Contracts (S2-i)

```ts
// packages/shared/api/group-publication-grants.ts (the shared group/publication feature)
export interface GroupPublicationTopicPermissions {
    readonly publish: boolean;
    readonly subscribe: boolean;
}
export type GroupPublicationTopicGrants = Readonly<
    Record<string, GroupPublicationTopicPermissions>
>; // { [topicId]: { publish, subscribe } }
export type GroupPublicationGrant =
    & GroupRef
    & Readonly<{
        principalId: PrincipalId;
        topics: GroupPublicationTopicGrants; // exact RallarWsUserTopicId keys, 1..64 entries, each with at least one `true`
        updated: AuditStamp;
    }>;
export const GROUP_PUBLICATION_GRANT_LIMITS = { maxTopicsPerPrincipal: 64 } as const;
export function decodeGroupPublicationGrant(
    value: unknown
): Either<readonly RallarValidationIssue[], GroupPublicationGrant>;
export function validateGroupPublicationGrant(
    grant: GroupPublicationGrant
): readonly RallarValidationIssue[];
export function resolveGroupPublicationPermissions(
    snapshot: GroupSnapshot,
    principalId: string,
    topicId: string
): GroupPublicationTopicPermissions; // D501

// packages/shared/api/group-types.ts
export interface GroupSnapshot {
    /* ...existing, then */ readonly publicationGrants: readonly GroupPublicationGrant[];
} // sorted by principalId
// GroupEventType gains 'publication-grant-changed'; payload: { principalId, topicId, permissions: { publish, subscribe } } — the resulting permissions; the actor is the event's `actor`

// packages/shared/api/group-state-delta.ts
export interface GroupStateDeltaEnvelope {
    /* ...existing, then */
    readonly publicationGrants: readonly GroupPublicationGrant[];
    readonly removedPublicationGrantPrincipalIds: readonly string[];
}

// packages/shared/api/state-types.ts
export interface GrantGroupPublicationRequest extends MutationActorInput {
    readonly topicId: string;
    readonly publish: boolean;
    readonly subscribe: boolean;
}
export interface RevokeGroupPublicationRequest extends MutationActorInput {
    readonly topicId: string;
    readonly publish: boolean;
    readonly subscribe: boolean;
}
export interface CreateGroupRequest {
    /* ...existing, then */ readonly publicationGrants?: GroupPublicationTopicGrants;
} // D494; absence = none

// packages/shared/api/group-policy-types.ts: GROUP_POLICY_REASON_CODES gains 'capacity' (D495)

// GS/persistence/group-state-runtime-namespaces.ts
export const PUBLICATION_GRANTS_NAMESPACE = 'group-state:publication-grants'; // key groupStateChildStorageKey(ref, 'grant', principalId)
// GS/policy/group-governance-policy.ts: GroupGovernanceAction gains 'grant-publication' | 'revoke-publication'
// AppInboxType.GROUP_PUBLICATION_GRANT, GROUP_PUBLICATION_REVOKE (awaitable); operations grantGroupPublication,
// revokeGroupPublication; route discriminants 'grant-group-publication', 'revoke-group-publication'
// GS/mutation/publication/compute-group-publication-grant-mutation.ts: pure, returns GroupMutationComputed

// REST (after /api/state/apps/{applicationId}/workspaces/{workspaceId}), 200 → GroupSnapshot
// POST /groups/{groupId}/publication-grants/{principalId}/grant/requests/{requestId}   body GrantGroupPublicationRequest
// POST /groups/{groupId}/publication-grants/{principalId}/revoke/requests/{requestId}  body RevokeGroupPublicationRequest
// 400 invalid body, 401, 403 policy denial (forbidden-role, member-not-active, group-archived, capacity, …), 404, 409 idempotency conflict

// WS/router/rallar-server-ws-router-contracts.ts
type RallarServerWsTopicAccess =
    | Readonly<{ participation: 'members'; }>
    | Readonly<{ participation: 'granted'; serverProducerIds: readonly string[]; }>; // a granted definition asserts scope 'room'
export type RallarServerWsTopicMetadata =
    & Readonly<{
        topicId: string;
        typeId?: string;
        scope?: RallarServerWsTopicScope;
        maxPayloadBytes?: number;
        fanout?: RallarServerWsFanout;
    }>
    & RallarServerWsTopicAccess;
// the metadata is now a union, so RallarServerWsTopicDefinition<T> becomes a type alias: metadata & { validate?, authorize? }
// RallarServerWsPublishInputDto gains `producerId?: string`; RallarServerWsPublishStatus gains 'refused';
// RallarServerWsPublishResult gains `refusal?: RoomPublicationAdmission.RefusalCode` (present exactly when status is 'refused')

// WS/room-publication/compute-room-publication-admission.ts
export namespace RoomPublicationAdmission {
    export type Publisher =
        | Readonly<{ kind: 'session'; sessionId: string; principalId: string; }>
        | Readonly<{ kind: 'server-producer'; producerId: string | undefined; }>;
    export interface Input {
        readonly snapshot: GroupSnapshot; // the probed snapshot, grants included
        readonly topic: RallarServerWsTopicAccess & Readonly<{ topicId: string; }>;
        readonly publisher: Publisher;
        readonly message: AuthorizedRoomAudienceMessage; // targets, delivery (leader), senderId
        readonly nowEpochMs: number;
    }
    export type RefusalCode = 'no-publish-grant' | 'topic-not-granted' | 'unsupported';
    export interface Refusal {
        readonly code: RefusalCode;
        readonly logMessage: string;
    }
}
export function computeRoomPublicationAdmission(
    input: RoomPublicationAdmission.Input
): Either<RoomPublicationAdmission.Refusal, RallarServerWsRoomAudience>;
// RallarServerWsRoomAuthorizationInput gains `topic`, resolved by the router from its registry ('members' for an implicit topic)

// packages/shared/al-contracts/al-control.ts: ALNackReason gains 'no-publish-grant' (codec, terminal in resolveALOutboundRelayRejection, harness decoder)
// packages/shared/alm/delivery/al-delivery-lifecycle.ts: ALDeliveryRefusalReason gains 'no-publish-grant'
// queue-pubsub/queue-box-pub-sub-bridge.ts: filterEligibleCapturedSessionIds?: (input) => Promise<readonly string[]> (D498)

// packages/shared-web/browser/messages/rallar-message-contracts.ts
export interface RallarTypedMessageChannelDefinition {
    /* ...existing */ readonly access: 'members' | 'granted';
}
// BrowserTypedChannelPolicy gains `access`; validateRallarTypedChannelPolicy: `$.access` 'invalid-access', and a granted
// channel without `topicId` is `$.topicId` 'missing-topic-id'; `onRtc` on a granted channel throws the `unsupported` issue
```

## 5. Dataflow, failure vocabulary and freshness (S2-i)

### 5.1 Per path

1. **Grant and revoke.** Route (one registrar each, in a new `register-group-publication-routes.ts`) →
   `toGroupStateCommand` (actor fields from the auth session) → AppInbox `GROUP_PUBLICATION_GRANT`/`_REVOKE` →
   **read** outside the transaction, in the one-statement mutation read: the group row, the actor and target member
   rows, the target's grant row, the idempotency row → **compute** (pure): idempotent replay or
   `idempotency-conflict`; `requireActiveGroup`; `canGovernGroupMember` with `grant-publication`/`revoke-publication`;
   target active; spectator `publish` refused `forbidden-role`; D492's effect; the 64-topic bound refused `capacity`;
   unchanged → `no-op`; otherwise the next row, `snapshotVersion + 1`, the `publication-grant-changed` event and one
   presence-summary row (D493) → **validate** (recompute and compare; read-scope complement) →
   **write(transaction, computed)**: the guarded batch (the group-row CAS first, then the grant row put or delete
   with its `expectedRevision`, then the receipt), the event insert, the outbox rows → commit → the summary worker
   writes the delta → browsers apply `publicationGrants`. A guard miss is `runtime-state-write-conflict`: rollback,
   then a fresh attempt with fresh authorization.
2. **Leave, remove, ban.** Their read scope gains the target's grant row; compute adds the row's delete (with
   `expectedRevision`; no effect when absent) to the existing membership batch; the event stays the membership event,
   and the delta lists the principal in `removedPublicationGrantPrincipalIds`. **Retirement** lists the namespace in
   `readGroupRetirementEntries` and `validateRetirementEntry`, and deletes the rows.
3. **Client WS publication.** Socket admission (`authorizeBeforeAdmission` → `readAuthorizedIngress`) → the room
   authorizer reads the probed snapshot → `readRoomPolicyDenial` (live session, active member, spectator,
   pre-activation, halted transport) → `computeRoomPublicationAdmission` with the topic from the registry and
   `{ kind: 'session' }`. A Left is NACKed (`no-publish-grant` → code `unauthorized`, reason `no-publish-grant`); a
   Right is frozen as `groupRecipientPeerIds` and as the receipt's expected recipients. Pending replay, inbox
   dispatch and `route` re-run the same function and only narrow; a refusal at any later pass NACKs and the message
   goes no further. `route` hands the audience to the live-only notice (`recipientSessionIds`) or to the outbox row
   (`admittedAudience`).
4. **Outbox dequeue, retry, repair, awaited send.** Each attempt calls the D498 port: captured ∩ the current admission
   audience of the row's topic. A revoked or departed session is not sent, and the receipt keeps it expected and
   unconfirmed.
5. **Server producer.** `publish({ message, fanout, producerId })` → `readServerPublishAudience` →
   `computeRoomPublicationAdmission` with `{ kind: 'server-producer', producerId }`. A Left returns
   `status: 'refused'` with its `refusal`; a `members` topic keeps today's audience.
6. **Proxy.** `readRallarServerWsPublicationAudience` passes the result topic's definition, and the function runs on
   the original sender session (D497).
7. **Unfrozen resolver.** A granted-topic message that would reach `resolveOutboundRecipients` without a frozen
   audience (the process-local resolver, `WS/targets/resolve-ws-group-target.ts:23-110`) is refused, never resolved.
8. **Browser send.** A granted channel: `strategy: 'rtc'` or `sendRtc` → `rejected`, `refused`/`unsupported`; any
   other strategy → WS. The send-time check (D500) → `rejected`, `refused`/`no-publish-grant`, or the WS leg; a server
   NACK `no-publish-grant` settles `relay-rejected`, terminal.

### 5.2 Failure vocabulary

Every expected failure is a value: a computed `rejected` outcome with its `policyDenial` (group-state), an
`Either` Left (`computeRoomPublicationAdmission`), a NACK (WS), a publish result (server) or a handle settlement
(browser). Nothing here throws, except a programmer invariant at definition time (a granted topic without
`scope: 'room'`, `onRtc` on a granted channel).

| Code                                                                                         | Value it lives in                                                                                             | Raised when                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `no-publish-grant`                                                                           | `RoomPublicationAdmission.Refusal`; `ALNackReason` (rejection code `unauthorized`); `ALDeliveryRefusalReason` | a session publishes on a granted topic without effective `publish` (D501), at any WS pass or at the browser's send-time check |
| `topic-not-granted`                                                                          | `RoomPublicationAdmission.Refusal`; `RallarServerWsPublishResult.refusal`                                     | a server publish on a granted topic whose definition does not list its `producerId` (or names none)                           |
| `unsupported`                                                                                | `RoomPublicationAdmission.Refusal` and NACK `unsupported` (D482); `ALDeliveryRefusalReason`                   | a granted-topic message without a `GroupRef` (world or principal broadcast); a granted channel's send on the `rtc` carrier    |
| `capacity`                                                                                   | `GroupPolicyDenied.code` with `details.limit 'topics-per-principal'`, 403                                     | a grant that would hold a 65th topic for the principal                                                                        |
| `no-subscribe-grant`                                                                         | `GroupPolicyDenied.code`, 403 (S2-ii)                                                                         | a subscribe to a topic without effective `subscribe`                                                                          |
| `forbidden-role`, `member-not-active`, `group-archived`, `group-deleted`, `group-not-active` | `GroupPolicyDenied.code` (existing)                                                                           | an admin targeting an admin or itself, a member self-granting, a spectator `publish`, a non-active target, an inactive group  |
| `membership-fenced`, `unauthorized`, `not-yet-in-sync`                                       | NACK reasons (existing)                                                                                       | membership refusals before the grant is read; a missing snapshot when the sender stamped floors                               |
| `runtime-state-write-conflict`                                                               | retryable AppInbox failure (existing)                                                                         | the group-row CAS missed; never surfaced to the caller                                                                        |

### 5.3 Freshness contract

Every WS admission and dispatch step on a granted topic (socket admission, pending replay, inbox dispatch,
`route`, and every outbox dequeue, retry, repair and awaited-connection send) decides against durable group-state
as of one version probe issued in that step, over the snapshot's rows with the grant prefix included. A grant,
revocation, leave, removal, ban or lease lapse committed before that probe statement is honoured by that step;
one committed after it is honoured by the next step. When the probe fails, or the snapshot is missing or corrupt,
the step does not admit or send: it refuses (`not-yet-in-sync` at admission when the sender stamped floors,
otherwise `unauthorized`), and a dispatch step leaves the row to its retry. The declared leak window is one
in-flight send, from the last step's probe to the socket write; for a live-only fanout that is `route` to the
socket write. A sender's floors make the server wait but never reveal a newer revocation. No granted-topic
decision reads the 60 s TTL cache or a process-local resolver snapshot. A recipient revoked after admission stays
in the receipt's expected set and reads unconfirmed. There is no claim of instantaneous or cluster-wide
revocation, and none over RTC, where granted topics are unsupported.

## 6. Proof, split and carries

### 6.1 S2-i proof

- **Grant mutation** (`packages/tests/shared-server/rallar-system/group-state/mutation/group-publication-grant-mutation.test.ts`
  and the inbox matrix): D492's add, remove and `no-op`; the 65th topic `capacity`; an admin targeting an admin or
  itself and a member self-granting `forbidden-role`; an owner self-grant applied; a non-active target; spectator
  `publish`; leave, remove and ban delete the row, and rejoin or unban-then-rejoin shows none; retirement deletes;
  archive keeps the row and enforcement denies; a CAS conflict injected at the guard retries on a fresh read and
  converges; an idempotent replay returns the first result, and a changed body is 409; a corrupt row fails closed
  (`GroupStateRepositoryInvariantCorruptionError`, no snapshot, the authorizer denies); persisted readback through
  the authority read; the topology fingerprint is unchanged by a grant-only write (D493).
- **Contracts**: `decodeGroupPublicationGrant` and the snapshot and delta validators accept the new fields and
  reject extra keys; `resolveGroupPublicationPermissions` tables.
- **Admission** (`packages/tests/shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.test.ts`):
  a `members` topic returns exactly `toAuthorizedRoomAudience`'s audience; on a granted topic, a publisher without
  `publish` is `no-publish-grant`; the audience holds only subscribe-granted principals' live sessions, a
  spectator with `subscribe` among them; a producer listed or not (`topic-not-granted`); a message without a
  `GroupRef` (`unsupported`); targeting only narrows; origin-session exclusion keeps the publisher's sibling session.
- **Every WS path** (`apps/api-v1/test/services/ws-room-authority-delivery.test.ts`, the router tests): a refusal
  at socket admission, replay, dispatch and `route`; a revoke committed between admission and `route` refuses at
  `route` (held dispatch); a revoke between enqueue and dequeue skips the revoked session at single-instance
  dequeue, cluster send, repair and the awaited hold, while the receipt keeps it expected; server producer and
  proxy; the unfrozen-resolver refusal.
- **Browser** (`packages/tests/shared-web/messages/**`): `access` validation; the `rtc` refusals; the send-time
  `no-publish-grant` settlement before any leg; a server NACK `no-publish-grant` settles `relay-rejected`; the
  public API snapshots and `check:browser-bundles` (a crossed budget is raised to the next KiB with the figure
  recorded).
- **REST and OpenAPI**: Deno route tests in `apps/api-v1/test/group-state/group-publication-routes.test.ts`
  (captured enqueue, forged actor replaced, malformed body refused before enqueue, path `requestId` only) and the
  three OpenAPI contract tables; the routing inventories; the idempotency-cutover route patterns; the event policy
  row `GROUP_PUBLICATION_GRANT`/`_REVOKE: { eventTypes: ['publication-grant-changed'], allowsNoOp: true }`.
- **Recipes**: `api-v1-group-publication-grants.json` (standard, HTTP; ids prefixed `pubgrant-`): create with a
  declared initial grant, joins, grant, readback in the group read's `publicationGrants`, the event, replay,
  changed-body 409, admin-on-admin and member self-grant 403, capacity 403, revoke, leave → rejoin → none,
  ban → unban → rejoin → none. `api-v1-group-publication-grants-cluster.json` (cluster, over D499's configured topic):
  grant on node A; a WS publish on node C is admitted to the subscribe-granted session only; revoke on node B; the
  next publish on node C is NACKed `no-publish-grant`; readback on all three.
- **Gates**: `deno task check` and `deno task test` (task permissions) in api-v1 and relic-hunter-server-v1;
  `test:unit`, `typecheck`, `typecheck:tests`, `check-changed-repo-style`, test-structure coupling;
  `test:api-v1:black-box:memory`, `:postgres` and `:postgres:medium-scale` (unweakened); a fresh
  `perf:api-v1:state-write` candidate against a baseline on freshly migrated databases (A-B-B-A on a noisy host;
  the grant selector's added SQL rows recorded as the regression reason); the local ALM smoke lane, unchanged
  except for `access`; the Branch Release Gate.

### 6.2 The two pull requests

- **S2-i** (D483–D488, D491's RTC refusal and REST proof; D492–D501): §4's contracts, §5's paths, §6.1's proof, the
  docs (`docs/rallar-api-reference.md` for grants and `access`, `apps/api-v1/src/group-state/README.md`, the
  product description, the roadmap's decision record and Release 9 section, the addendum's §7 "As applied").
- **S2-ii** (D489, D490, D491's four-role proof): §7.

### 6.3 Owners touched (S2-i)

The shared contracts in `packages/shared/api/` (the new `group-publication-grants.ts`, the group types, the delta,
both validators, the request DTOs, the policy codes), `al-contracts/al-control.ts` and its codec, and
`alm/delivery/` and `alm/outbound/control/` for the NACK and refusal reason. In group-state, the persistence
(namespace, `publication/**`, the authority, mutation and retirement reads, snapshot assembly), the mutation family
(contracts, read scope, state validation, the new `publication/**` compute, orchestration, the membership compute
and write, command validation), governance, the inbox registries, the descriptor classifier, the presence-summary
delta, `app-inbox/**` and the formation metrics. In WS, the room authorizer, the server-publish reader, the new
`room-publication/**`, the router and registry, the queue bridge, and the queue-box server's dequeue authority,
planning and service; the five topic installers. The browser's `messages/**` and `rooms/room-session.ts` with the
public entry points, snapshots and budgets. api-v1's `group-state/**`, `configuration/**` and composition, and the
OpenAPI. The black-box recipes, matrix and state-write evidence, the harness's NACK decoder and typed channels, and
the tests under `packages/tests/**` and `apps/api-v1/test/**`.

### 6.4 Carries to later slices

- **Slice 3, restricted RTC parity**: an authenticated original publisher, relay versus application permission, RTC
  fallback and repair under role churn, and a receiver-side drop of granted-topic traffic arriving on a raw RTC lane.
- **Ordered subscription entry** (the addendum's second later outcome).
- **An admission-time declared grant for joiners** (D494), with its persisted declaration and lifetime rule.
- **The members-topic re-check at dequeue** (D498): today's leave and ban gap on outbox rows of `members` topics.
- **A topic-policy advertisement** that lets the browser refuse synchronously on a topic's participation (with
  D482's).
- **A `publicationVersion` grants-only floor** on the group row, if browsers need it (D484).
- **Batched subscription renewal**, if S2-ii's per-subscription renew traffic shows in the state-write gate.
- **S2-ii defaults, decided here; confirm at the S2-ii design**:
  - the subscribe and unsubscribe body carries the asserting `connectionGenerationId` beside `{ topicId }`, since
    the HTTP request is bound to no socket;
  - renewal is the same subscribe every 20 s, extending the 120 s lease;
  - a revoke of `subscribe`, and leave, remove and ban, delete the principal's subscription rows in the same write;
  - the captured outbox policy records each recipient's `subscriptionGeneration`, and the dequeue re-check drops a
    session whose current generation differs;
  - in `rooms.grantTopic(member, topic, { publish, subscribe })` and `rooms.revokeTopic`, `member` carries the room
    (`room`, `principalId`, `options?`);
  - the `subscribe(handler)` token type is `RallarTopicSubscription`.
- **The measured operating envelope**: subscription and permission churn, multi-group producers, slow consumers.

## 7. S2-ii: subscriptions, the audience intersection, the browser roles, the four-role family

Decided in outcome by D489–D491; the contracts, cells and owners are written here after S2-i merges, from fresh
surveys of `main`, as Slice 1's §7 was. The decided outcomes:

- **The store.** `group-state:subscriptions`, one row per (group, session, topic), keyed
  `<groupKey>:session=<sessionId>:topic=<encoded topicId>` (topic ids may contain `:`; the connect latch is the
  five-part precedent). The complete row: `sessionId`, `principalId`, `topicId`, `connectionGenerationId`,
  `subscriptionGeneration`, `leaseExpiresAtEpochMs`, `admittedAtGroupRevision`; the row's store expiry is the lease.
- **The commands.** `POST .../groups/{groupId}/sessions/{sessionId}/subscribe/requests/{requestId}` and
  `.../unsubscribe/requests/{requestId}` with `{ topicId }` and the asserting `connectionGenerationId` (the HTTP
  request is bound to no socket, so the generation that the multi-tab rule compares travels in the body), and
  `GET .../groups/{groupId}/sessions/{sessionId}/subscriptions`. Self-session guard; AppInbox read → compute →
  validate → write with the session's subscription row as its own guard (no group-row CAS, so no
  `snapshotVersion` or roster bump, no event, no delta). Subscribe requires an active member, a live presence
  session whose generation matches, and effective `subscribe` (else `no-subscribe-grant`); outcomes `subscribed`,
  `renewed`, `unsubscribed` and `not-subscribed` are values. A new generation increments `subscriptionGeneration`;
  an unsubscribe from another generation is `not-subscribed` and removes nothing. Renewal is the same subscribe
  every 20 s, extending the lease to 120 s.
- **Authority and lifetime.** The publication authority read is the probed snapshot plus the group's live
  subscription rows in the same probe statement, outside `causalRevision`. A revoke of `subscribe`, and leave,
  remove and ban, delete the principal's subscription rows for that topic or group in the same guarded batch, so a
  re-grant never revives an old subscription. Session close and lease lapse remove interest without a write.
- **The intersection.** `computeRoomPublicationAdmission` gains the subscriptions: the audience is live
  active-member sessions ∩ effective `subscribe` ∩ a subscription whose generation equals the live presence
  session's and whose lease holds ∩ targeting and leader. The captured outbox policy records each recipient's
  `subscriptionGeneration`, and the D498 port drops a session whose current generation differs, so a new subscription
  generation never inherits an old row's obligation; the receipt keeps the frozen expected set. An empty audience
  is admitted with zero recipients.
- **The browser.** `RallarRoomMember.topicGrants` (`{ [topicId]: { publish, subscribe, role } }`, effective per
  D501), `RallarRoomSession.topicRole(topicId)` returning `RallarRoomTopicRole` (`'none'` when absent), and
  `rooms.grantTopic(member, topic, { publish, subscribe })` / `rooms.revokeTopic` returning the `GroupSnapshot`.
  On a granted channel, `subscribe(handler)` returns a `RallarTopicSubscription` token with
  `status(): 'pending' | 'active' | 'refused' | 'lapsed'`, `wait()` and `unsubscribe()`. One owner,
  `messages/browser-topic-subscriptions.ts`, counts tokens per tab and per canonical (GroupRef, topicId), sends the
  first subscribe and the last unsubscribe, renews on the heartbeat cadence, re-asserts every held subscription
  with the new `connectionGenerationId` on socket reopen, and releases all at session end. A tab whose socket was
  replaced sends nothing remote.
- **The four-role family.** Roles `sender` (user A) and `publisher-b` (user C) produce; `receiver` (user B) and
  `sibling` (A's second session) consume. Cells: subscribe then publish (only subscribed sessions receive; the
  sibling receives the sender's publication); two tokens on one page, where one unsubscribe keeps the other; revoke
  during a held dispatch (a consumer's product socket dropped, a publish held for its awaited reconnect, a revoke,
  the reconnect, nothing delivered, the receipt expecting it unconfirmed); reconnect with a new generation
  re-asserts and receives; each over `ws` and `rtc-with-ws-fallback`; a `same-context` successor cell, where the
  owner's late cleanup cannot remove the successor's subscription. Harness: `messages.subscribe`,
  `messages.unsubscribe` and a subscription-state read; owner-side grant and revoke through `http.request`; a
  product-socket drop `fault.inject` action; `createThreeAgentRun` generalized to N agents. REST recipes for
  subscribe and unsubscribe (readback, idempotency, the stale-generation outcome, `no-subscribe-grant`). The hosted
  four-agent manifest carries only the cells that share no principal, as guidance.
