# ALM A1 design proposal: principal, world, all, and fixed audiences with carrier parity

Release 6, slice A1 of [alm-improvement-plan.md](alm-improvement-plan.md). Written from a code survey of
`main` at `b751caebf` (R2b merged, #643). It serves product completion criterion 7: every target mode has
one documented semantic, proven by the conformance lane over both carriers and exercised by one of the
two games; a guarantee a carrier cannot provide rejects explicitly.

The roadmap's outcome for A1: unicast, room multicast, broadcast over room, world, all, and principal,
and fixed recipient lists, with RTC and WS parity; WS uses the existing server resolver; RTC resolves
room and principal from the snapshot session set; world and all take the WS route automatically when
fallback is allowed and are typed carrier-unsupported otherwise.

## 1. The problem

The wire already names five broadcast shapes (`room`, `world`, `all`, `principal`, and a room broadcast
with `recipientPeerIds`), but only `room` has one meaning that both carriers implement:

- **Scope is not bound for the audiences the server resolves itself.** A client's `world`, `all` or
  `principal` broadcast that is not a state-sync message reaches every open connection on the instance
  (`create-ws-server-target-resolver.ts`), no recipient scope is applied at the outbox fanout
  (`publish-rallar-server-ws-message.ts`), and with Postgres pub/sub a `world`/`all` notice travels as
  `broad` with no scope, so remote instances skip the scope filter
  (`filter-eligible-live-ws-session-ids.ts`). The ingress binding of D100 compares only an addressed
  `groupRef` or `principalRef` with the sender's scope.
- **`principal` has two meanings.** The live publication resolves the principal's own sessions
  (`create-api-v1-ws-live-publication.ts`); the state-sync resolver and the contract comment say own plus
  co-group sessions (`state-sync-routing.ts`, `al-contract.ts`). Nothing ties a client's `principalRef` to
  its own principal or to a shared room.
- **No sender-named fixed list, no receiver enforcement.** The only list field on a broadcast,
  `recipientPeerIds`, is documented as server-captured and accepted only with room scope
  (`assert-persisted-al-targets.ts`); the shared receiver planner reads neither scope, `principalRef` nor
  that list (`al-policy.ts`), so an RTC peer delivers and relays any broadcast it is not excluded from.
- **The browser cannot say most of it, and the default path throws.** `RallarWsSendInput.scope` has no
  `principal` and no list; `newALBroadcastMessage` cannot build a principal broadcast; `sendRtc` builds
  room multicasts only; and `sendRoomWithFallback` throws a validation error for any non-room scope before
  a handle exists (`browser-rallar-message-sender.ts`), so "carrier-unsupported" is an exception today,
  not a typed result.
- **Nothing proves parity.** The conformance lane and manifests 18 and 22 carry no world, all, principal
  or list cell; the harness `messages.send` accepts `scope: 'room' | 'world' | 'all'` only. Relic's AI
  suggestions, the roadmap's consumer, are room broadcasts generated in the browser.

What exists and is reused: the frozen-audience machinery (`computeFrozenAudience`,
`resolveALFrozenMulticastAudience`, `toFrozenAudience`, the receipt aggregate's expected set), the
group resolver (`resolveWsGroupTargetRecipients`) and the group snapshot's per-session `principalId`,
the scope authority (`toWsQueueBoxServerScopeAuthorization`, `recipientScope`,
`WsQueueBoxServerRecipientSelection.isCurrentAuthorized` with its principal filter), the scoped-world
producer semantics (`scoped-world-broadcast` provenance: `recipientScope` plus `broadWorld`), the typed
refusal `unsupported` with its `carrier-refused` evidence and fallback disposition (D42, D91), and the
lane's carrier-by-family instantiation with the three-agent roles (R2's membership-fence family).

## 2. The design, per concern

### 2.a One meaning per audience (D156)

| Audience   | Meaning                                                                                                      | Addressed by                             |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| unicast    | One session, in a room when `groupRef` names it (unchanged, D53, D75).                                       | `peerId` (+ room)                        |
| room       | The room's live sessions at the sender's snapshot, minus `exceptPeerIds` (unchanged).                        | room                                     |
| principal  | The principal's live sessions **in the addressed room** at the sender's snapshot.                            | room + `principalId`                     |
| fixed list | The sender's list of session ids **in the addressed room**, resolved to the list ∩ the room's live sessions. | room + `recipientPeerIds`                |
| world      | Every authenticated live connection in the sender's authenticated scope (application + workspace).           | `scope: 'world'`                         |
| all        | Every authenticated live connection the server holds, across scopes: a server and proxy audience only.       | server `toAll`; a client's `all` refused |

A client-addressed principal or list audience is room-bounded on both carriers, so both carriers resolve
the same session set from the same authority: the room snapshot's `activeSessions` (each carries
`principalId`) in the browser's RTC path, the group resolver's live sessions on the server. "Own plus
co-group sessions" is not an audience a client addresses; it is the server's state-sync fan-out of
client snapshots, which keeps its provenance-scoped path and is not a client send. The contract comment
and the product description say the room-bounded meaning.

`world` takes the meaning the server already gives its own scoped world rows: the sender's
authenticated scope. `all` crosses scopes by definition, which no client send may do under D100, so a
client's `all` is refused `unauthorized` at WS ingress and `unsupported` on RTC; the router's `toAll`
and the server's own publications keep it.

### 2.b Carrier support and the routed decision (D157)

| Audience   | RTC                                                             | WS                                    | Default strategy (`rtc-with-ws-fallback`) |
| ---------- | --------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| room       | multicast, frozen audience (unchanged)                          | room broadcast (unchanged)            | RTC, WS on a fallback trigger             |
| principal  | multicast, frozen audience narrowed to the principal's sessions | `broadcast/principal` + `groupRef`    | RTC, WS on a fallback trigger             |
| fixed list | multicast, frozen audience narrowed to the list                 | `broadcast/room` + `recipientPeerIds` | RTC, WS on a fallback trigger             |
| world      | refused `unsupported`                                           | `broadcast/world`                     | WS directly                               |
| all        | refused `unsupported`                                           | refused `unauthorized` (client)       | WS directly, then `rejected`              |

"Carrier-unsupported" is the existing typed refusal `unsupported` on the carrier that cannot carry the
audience (the D42 class: an unimplemented target on a carrier), recorded as `carrier-refused` evidence
when the strategy hands the send to WS and as the `rejected` verdict when it does not. No new state, no
new value (D122). The browser sender stops throwing for a non-room scope: a world send on a strategy that
allows WS is admitted on WS at once (the roadmap's "takes the WS route automatically"); on strategy
`rtc` it is admitted on RTC, refused `unsupported`, and the handle ends `rejected` with that refusal.
Principal and list sends with a room follow the room path on both carriers; a principal or list send
without a room is a validation error like a room send without a room today (`missing-room`).

### 2.c Scope binding at WS ingress (D158)

D100 extends from "the addressed scope" to "the audience the server resolves":

- a client's `world` broadcast binds `recipientScope` to the connection's authenticated scope, and the
  cluster's live notice for it carries that scope (a `broad` notice is scoped for `world`; it stays
  unscoped for the server's `all`), so every instance filters with `isCurrentAuthorized`;
- a client's `principal` broadcast requires `groupRef` and a `principalRef` in the connection's scope
  (the existing comparison), and the router reads the room from `groupRef` as for a room broadcast;
- a client's `all` broadcast is refused `unauthorized`;
- a client's fixed list requires room scope (the existing decoder rule) and is narrowed to the room's
  authorized sessions at the frozen snapshot, as a multicast's intended audience is today.

The server's own paths — state-sync principal fan-out, CRDT `scoped-world-broadcast` rows, client-state
`scoped-principal-broadcast` rows, the router's `toAll` — are not client sends and do not change.

### 2.d Receipts, fences and repair for the room-bounded audiences (D159)

A principal or list audience is a frozen room audience: the WS authorizer returns it as `roomAudience`
narrowed by principal or list, so the receipt aggregate opens with that expected set, `receiver` and
`all-logical-recipients` are supported (`validateALAckSupport` gains the two shapes), the roster fence
is stamped and read as for any room send (D143), and repair narrows to the admitted audience (R2b). On
RTC the origin freezes the narrowed audience with `snapshotVersion`, so the existing multicast planner
rule (the member set contains self) enforces membership on every peer; the planner also honours a room
broadcast's `recipientPeerIds` on receipt, so a listed audience delivered over WS is enforced the same
way. `world` keeps ack `none` (no logical audience, D42); a client cannot ask `receiver` of it.

### 2.e Public surface (D160)

- `RallarWsSendInput.scope: 'room' | 'world' | 'principal'`, plus `principalId?: string` (with
  `scope: 'principal'`, the room named) and `recipientPeerIds?: readonly string[]` (room scope). `'all'`
  leaves the browser input, since no client send may carry it; the shared builder keeps it for the server.
- `RallarRtcSendInput` gains `principalId?` and `recipientPeerIds?`; the room channel's typed options
  carry both.
- `newALBroadcastMessage` accepts `scope: 'principal'` with a required `principalRef` option, and
  `recipientPeerIds` with room scope; the wire validator's rules stand and the `recipientPeerIds` comment
  says "the sender's fixed audience inside the room".
- The frozen-audience computation takes an optional narrowing (`principalId` or `recipientPeerIds`) at
  the origin, one function for both carriers' room-bounded audiences.
- The shared planner's `isLogicalRecipient` reads a broadcast's `recipientPeerIds`.

### 2.f The proof (D161)

A new lane family `scenarios/audiences/` beside `membership-fence/`, instantiated per carrier like every
family: `principal-delivery` (two sessions of one principal and a third session in the room; only the
principal's two receive; `ws`, `rtc`, `rtc-with-ws-fallback`), `fixed-list-delivery` (a list of one of
three; `ws`, `rtc`, `rtc-with-ws-fallback`), `world-routing` (`ws` delivers to every session of the
scope; `rtc` ends `rejected` with refusal `unsupported`; `rtc-with-ws-fallback` delivers over WS with no
RTC leg) and `all-refused` (`ws` ends `rejected` with refusal `unauthorized`). The harness `messages.send`
gains `principalId` and `recipientPeerIds`, and the lane gains a role that signs in a second session of
the sender's principal. Manifests 18 and 22 stay byte-identical; the family is withheld from them as the
membership-fence family is (D148).

### 2.g The consumer (D162)

Relic's AI planning suggestions, generated in the browser and broadcast to the room today, become a
principal broadcast in the room over WS: the asking hunter's sessions receive their own proposal and
nobody else's. The receive filter keeps its room and revision checks. This is the roadmap's "AI
suggestions addressed to a principal audience".

### 2.h Carries (D163)

- Per-player private events from the Relic server: the server has no principal publish helper and no
  server-originated conformance cell (D155); the room-bounded principal audience is ready for it. Carried
  to A2's consumer work.
- The deployment-wide principal audience (a principal's sessions across rooms) stays the server's
  state-sync machinery; no client send addresses it.
- A list longer than 256 entries is refused by the collection limit; no batching.
- A listed session outside the room is narrowed away silently, as a multicast's intended audience is; the
  empty-audience behaviour is the existing one.
- A client's `all` is a typed rejection; the roadmap's "broadcast over all" from a client is corrected to
  the server audience it is.

## 3. Decisions (2026-10-07)

- **D156** One meaning per audience: room; principal = the principal's live sessions in the addressed
  room; fixed list = the sender's session ids in the addressed room; world = the sender's authenticated
  scope; all = every authenticated connection the server holds, a server and proxy audience, refused
  `unauthorized` from a client.
- **D157** Carrier matrix and routed decision: RTC carries room, principal and list from the snapshot
  session set; world and all are refused `unsupported` on RTC; the browser sender routes a world send to
  WS when the strategy allows it instead of throwing; carrier-unsupported is refusal `unsupported` on the
  named carrier with `carrier-refused` evidence on fallback and `rejected` otherwise.
- **D158** WS ingress binds a client's world audience to its authenticated scope (and the cluster notice
  carries that scope), requires a room for a client's principal audience, and refuses a client's `all`.
- **D159** Principal and list audiences are frozen room audiences: receipts, roster fence and repair as
  for a room send; the shared planner honours a broadcast's `recipientPeerIds`.
- **D160** Public surface: `scope: 'room' | 'world' | 'principal'`, `principalId`, `recipientPeerIds` on
  both carriers' inputs and the room channel; `newALBroadcastMessage` builds principal and listed room
  broadcasts; one frozen-audience narrowing for both carriers.
- **D161** The audiences lane family over the three carriers with a same-principal second session;
  manifests 18 and 22 unchanged.
- **D162** Relic's AI suggestions ride a principal broadcast in the room.
- **D163** Carried: server-originated private events, the deployment-wide principal audience, lists over
  256, silent narrowing of a listed non-member, and the client `all` correction.

## 4. Corrections to the roadmap and the product description

- The A1 outcome row's "broadcast over ... all" from a client becomes the server audience (D156); the
  roadmap row and the product description's broadcast semantics say so.
- The product description's `principal` ("own live sessions plus the explicitly defined co-group
  audience") and the contract comment on `principalRef` become the room-bounded meaning; the co-group
  fan-out is named as the server's state-sync path.
- The audit's F16 line and the requirement matrix's PC7 row record A1 as delivered at the close.

## 5. Carries: what A1 does not do

Leader ACK and exclusive ownership (A2); reply correlation (I1); server-originated principal publication
and its conformance cell; any change to state-sync routing, CRDT or client-state provenance; a
deployment-wide client audience; receipts for `world`.
