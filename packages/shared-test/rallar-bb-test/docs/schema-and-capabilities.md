# Rallar Black-box Test Schemas And Capabilities

`packages/shared-test/rallar-bb-test/schema.ts` is the machine-readable contract
for browser-agent commands and recipes. It sits beside
`rallar-black-box-test-contracts.ts`:

- `rallar-black-box-test-contracts.ts` defines the TypeScript runtime contract.
- `schema/rallar-black-box-command-fields.ts` is the one list of the fields each
  command and each nested command object may carry, which of them are
  required, and the shared enum values. The JSON Schema, the capability
  metadata, and the control-command validator all read it; the compiler rejects
  a schema branch whose properties differ from it.
- `schema.ts` defines the JSON Schema objects for UI validation,
  control-server documentation, runner handoff, and distributed-run manifests.
- `schema/rallar-black-box-command-capabilities.ts` defines the command
  capability metadata.
- `schema/json-schema-validation.ts` is the browser-safe JSON Schema validator.

Runtime parsing and distributed artifact analysis must stay aligned with these
schemas. For black-box control/distributed-run behavior, update
`control-protocol.ts`, `control/validate-rallar-black-box-test-command.ts`,
`control-snapshots.ts`, `distributed-artifact-analysis.ts`, and generated
manifest JSON together so the browser agent, CLI analyzer, SPA, and Hetzner
workflow agree. The control-command validator deliberately does not import the
JSON Schema or the capability metadata, so the headless agent bundle carries
neither.

## Schema Catalog

The exported catalog is `RALLAR_BLACK_BOX_SCHEMA_CATALOG`.

It currently contains:

- `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`
- `RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA`
- `RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA`
- `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA`

`packages/shared-test/black-box-runner/schema.ts` owns the separate
`BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA`. That schema describes runner
scenarios with `variables`, `connections`, and `steps`. It intentionally stays
provider-neutral and does not mirror Rallar facade internals.

The distributed-run manifest and lifecycle contract are documented in
`packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`.

Prompting guidance for using these schemas with AI recipe generation is in
`packages/shared-test/rallar-bb-test/docs/ai-recipe-prompt-guide.md`.

Schema compatibility guidance for AI prompt authors and external tools is in
`packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`.

Composite browser-agent primitive planning is documented in
`packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md`.

Composite result paths, flat summaries, trees, timelines, and redacted display
entries are documented in
`packages/shared-test/rallar-bb-test/docs/composite-result-contract.md`.

Runtime diagnostic payloads for WS/RTC warnings and adapter recoverable
failures are documented in
`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`.

## Wait Since Cursor

`wait.match.sinceEpochMs` ignores events recorded before that wall-clock stamp.

A wait scans the whole event buffer and answers with the newest match, so a scenario that
legitimately produced the same event earlier cannot say which occurrence it means. The cursor is how
it says so: capture a stamp before the step that should produce the event, and pass it on the match.
Without it a pin can be satisfied by history rather than by the behaviour under test, which is the
same hazard `absent: true` carries in the other direction.

## Wait Result References

A `{resultCache.<commandId>.<path>}` token in `wait.match.contains` stands for the string or number
an earlier command of the same runtime returned at that path, for example
`{resultCache.<send commandId>.value.msgId}`. The wait resolves every token once, when it starts, and
reports the resolved match in its result. A token naming no string or number value fails the wait
with `RALLAR_BLACK_BOX_WAIT_INVALID` and the unresolved reference in its details. This is how a
recipe pins a wait on an identity it cannot know when it is authored, such as the msgId a send was
given.

## Formation Commands

`formation.command` and `formation.readiness` drive the shipped browser room
formation handle, so both are browser-only and both address exactly one room.

`formation.command` issues one of the eight lifecycle commands (`plan`,
`connect`, `activate`, `reconfigure`, `pause`, `resume`, `reset`, `start`) and
returns the group snapshot receipt beside the room formation summary. `layout`
belongs to `connect` and `landing` to `reconfigure`; naming either on any other
command is refused rather than dropped, so a mis-addressed field is reported
instead of silently losing the fence or the landing it asked for.

`formation.readiness` delegates to the browser's canonical event-driven room
wait and returns the summary captured when that wait resolves. It observes
only: it never refreshes the room and never opens lanes, which is what makes it
evidence about the browser rather than about the harness that drove it. It
resolves when the room's transport state is `open` **and** the room has at
least one desired peer, because an accepted layout with no desired peers reads
`open` immediately and would satisfy a bare state check vacuously.

Unlike `rtc.connect`, whose room fields are each independently optional, a
formation command must name its room: an exact `roomRef`, or an
`applicationId` together with a `roomId`. `workspaceId` defaults to `default`
in the browser runtime's own room resolution, not in the control protocol.

## Capability Metadata

`RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` has one entry for every
`RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` value:

- command kind and human title
- required and optional fields, taken from the command field definition
- supported provider modes
- supported runtime surfaces
- live-service requirements
- expected artifacts/evidence
- a validating example command

The capabilities are the source for UI help, catalog filtering, and future
distributed recipe preflight checks.

A control agent's own registration carries a second, separate capability
document. `decodeControlAgentCapabilities` requires the `crdt`, `assertions`
and `messaging` blocks, rejects unknown CRDT transports, assert operators and
message carriers, and rejects the registration outright when any block is
absent or malformed. The identity around it must name `sessionLabel` and
`updatedAtEpochMs`, and a reported `location` must carry its `precision`. The
`messaging` block looks like this:

```json
{
  "supported": true,
  "carriers": ["ws", "rtc", "rtc-with-ws-fallback"],
  "faults": true,
  "storageCounters": true,
  "reload": true
}
```

An agent built before the ALM commands landed therefore cannot register against
a current control server.

## ALM Commands

Eight command kinds drive the Application Layer Messaging surface. All eight are
browser-only: the in-process runner adapter refuses them with the
`browser-only-command` code rather than translating one into an `rtc.send`, and
that refusal fails the step.

`messages.send` takes `carrier` (`ws`, `rtc`, `rtc-with-ws-fallback`), `typeId`
and `payload`, and optionally `connection`, `topicId`, `roomRef`, `scope`, `principalId`, `recipientPeer`,
`reliability`, `ack`, `ownership`, `resourceId`, `durability`, `onStorageUnavailable`, `ttlMs`, `orderingKey`,
`seq`, `handleId`, `minSnapshotVersion`, `qos` and `toPeer`. It returns `{ handleId, msgId, carrier, status, reason? }`.
`ownership` (`shared`, `exclusive`) and `resourceId` pass unchanged to the product's typed send options of the same
names; absent, the send is `shared` on a fresh resource id, as a product send is. A recipe that names a
`resourceId` lets two agents' sends meet on one resource key, which an exclusive claim needs.
`durability` (`volatile`, `local-checkpoint`, `local-outbox`, `local-inbox`) declares the typed
channel's durability; absent, the send is volatile. `onStorageUnavailable`
(`refuse`, `volatile`) is the channel's choice when its storage cannot hold a
durable send: `refuse` fails the send with `failure.kind: 'storage-unavailable'`,
`volatile` admits it once more without storage and names the lost durability on
the observation's `durabilityDowngrade`; absent, the send refuses.
`handleId` defaults to the command's own `commandId`, and every later delivery
command addresses the send through that handle. Supersedence (`key`) is not part of
this release, and neither is a literal peer id (`toPeerId`), which no recipe knows
when it is written; naming either one fails recipe validation. `toPeer` addresses
one peer by its lane role instead: `server` is the id the WS server answers as
(`serverPeerId()`, learned from `/api/config`), and `receiver` is the one other
live session of the connection's room, read from the page's cached roster with the
page's own session left out. The page resolves the role at send time and hands the
product's typed send `{ peerId }` on a channel opened with purpose `command`, the
purpose a product addresses one peer with; the recipe's own `ack` still wins. A role
the page cannot resolve (no server id, or a roster without exactly one other live
session) fails the command with `RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED` and opens no
handle. The roster names no role, so a room with two recipients has no resolvable
`receiver`, and the three-agent family addresses no peer. `toPeer: 'server'` is a
WS-only target, because the server is no RTC peer (C9): on `rtc` or
`rtc-with-ws-fallback` the product's typed send refuses it before admission with
a validation error of code `unsupported`, which carries no page prefix, so the
command fails with `RALLAR_BLACK_BOX_ALM_INVALID_COMMAND_INPUT`, opens no handle and
puts nothing on either carrier. The page resolves no role until that send and does
not pre-check the carrier; `server-command` therefore runs on `ws` only.

`minSnapshotVersion` is a harness floor on the room snapshot a receiver must hold
before it admits the send: `{ absolute: n }`, or `{ aboveCurrentBy: n }`, which
the page resolves at send time against the sender's own cached room version (the
floor the product stamps when a send states none). Either `n` is a positive
integer, and exactly one form is named. The page passes the absolute floor to the
product's typed send option `minSnapshotVersion`, which the room target carries
over RTC and over the fallback carrier; the product still stamps the higher of
that floor and the sender's own version. Absent, the send states no floor and the
product stamps the sender's version. `aboveCurrentBy` fails the send when the
sender has no cached snapshot for the room.

`qos` is `{ ack: { algo } }`, where `algo` is `none`, `hop`, `subtree` or
`receiver`, and nothing else is named. The page passes it unchanged to the
product's typed send option `qos`, the caller's QoS request, which the envelope
carries and which overrides the ack algorithm `ack` implies. Absent, the product
normalizes the QoS the delivery options imply. The conformance recipes use it on
every `rtc` or `rtc-with-ws-fallback` recipe send that asks for
`ack: 'receiver'`, whichever carrier the send starts on: until the RTC overlay
tracks logical receipts it refuses `receiver`, so those sends ask for `hop` by
name and keep reading hop receipts. `ws` recipe sends keep `receiver`, the
logical algorithm.

A replay is the other shape of `messages.send`: it names `replayOnCarrier:
{ handleId, carrier }` (`carrier` is `ws` or `rtc`), optionally `connection`, and
nothing else a send would. `carrier`, `typeId`, `topicId`, `payload`, `roomRef`,
`scope`, `principalId`, `recipientPeer`, `reliability`, `ack`, `ownership`, `resourceId`, `durability`,
`onStorageUnavailable`, `ttlMs`, `orderingKey`, `seq`, `handleId`, `minSnapshotVersion`, `qos` and `toPeer`
are each refused beside it, by the control validator and by
the page, because the replayed envelope already fixes them. It is a harness
capability, not a product path: the product falls back to its second carrier only
after an `unroutable` verdict or a `refused` `unsupported` one (an ack algorithm the
first carrier cannot track), so one logical message never reaches both. The page
reads the envelope the earlier handle's first carrier captured and admits that
same envelope through the named carrier's own admission call, the one a fallback
makes. It returns `{ handleId, msgId, carrier, verdict, reason? }`: the named
handle, that carrier's admission verdict (`admitted`, `duplicate`, …) and the
verdict's detail when it has one. The sender's two outbounds keep separate sent
rows, so the replay reads `admitted`. A replay opens no handle of its own, but the
replay carrier's settlements land on the earlier handle, so a later
`messages.receipts` for it is not first-carrier evidence. A replay the page cannot
perform (no connected session, or the capturing carrier no longer retains the
envelope) fails with `RALLAR_BLACK_BOX_ALM_REPLAY_UNAVAILABLE`.

`messages.control` is a harness capability, not a product path. It names `carrier`
(`ws` or `rtc`), `typeId` (an `al.control.*` id), `msgId`, `ackedMsgId` and `toPeerId`,
and optionally `connection`. The page builds, under the authored `msgId`, the ACK
envelope its own session would send for `ackedMsgId` to `toPeerId`, that message's
sender, and swaps in `typeId`, so the addressee's admission outcome names this one
control, and so a recipe can send a control version its addressee does not support.
The envelope goes through the carrier admission a product control takes. It returns
`{ msgId, typeId, carrier, verdict, reason? }`: the control's own msgId and that
carrier's verdict, which says only whether this page's carrier took the control:
`admitted`, or another admission verdict such as `duplicate` for a msgId this page's
store already holds. The addressee records its own `admission-outcome` for the control, which is
the verdict a recipe asserts on the addressee's page. `msgId`, `ackedMsgId` and
`toPeerId` may name `{resultCache.<commandId>.<path>}` tokens, the same tokens a
`wait` resolves in `contains`, such as
`{resultCache.<wait>.value.event.payload.senderId}` of an earlier message wait. A
token no earlier command returned fails the command as invalid input. A page with
no connected session fails with `RALLAR_BLACK_BOX_ALM_RAW_CONTROL_UNAVAILABLE`.

The `receipted-audience` conformance scenarios run on three agents: `sender`,
`receiver` and `recipient-b` (D45). Every send asks for `all-logical-recipients`. The
sender reads its receipt only after the scenario window, never by polling
`acknowledged`, and pins the state the handle ended in (`acknowledged` for a receipt
that completes, `expired` for one that ends timed out), the receipt mode and the
length of each recipient list. Every send payload names its carrier, and the raw ACK
of `unknown-ack-version` its own authored msgId, so a wait in a combined recipe that
runs every carrier on one page never matches an earlier carrier's event. Its
recipe metadata `almReceiptRoles` names, per send handle, the recipient roles the
receipt confirms and leaves unconfirmed. The identity assessment joins each list to
the sessions of those roles after the run.

- `aggregated-receipt`: both recipients are confirmed. Over `ws` the sender also
  waits for its committed `control-admission` of `al.control.receipt.v1`; that is the
  first receipt frame, the `admitted` one, and the `acknowledged` read proves the
  `complete` one.
- `missing-recipient-retry`: `recipient-b` holds its ACK back with a fault it keeps
  armed until it is released. A one-shot `drop` would not lose the ACK: the RTC
  channel settles a dropped frame `not-ready` and its sender resubmits it 50 ms
  later.
  - Over `rtc` and `rtc-with-ws-fallback`, `recipient-b` releases the ACK only once
    the origin's retried copy reaches it as a duplicate. The receiver proves no
    retried copy ever reaches it, and the receipt confirms both recipients.
  - Over `ws` the room topic fans out live-only, so the WS server keeps no copy to
    retry. `recipient-b` proves no copy is retried, and the short-lived send's
    receipt ends timed out: the handle reads `expired`, with the receiver confirmed
    and `recipient-b` unconfirmed.
- `unknown-ack-version` (`rtc`, `rtc-with-ws-fallback`): `recipient-b` answers the
  send with a raw `al.control.ack.v1` through `messages.control` and asserts its own
  carrier took it (`verdict` `admitted`), and the sender waits for its own
  `admission-outcome` of that authored msgId refusing it `rejected`/`unsupported`.
  The authored msgId is the carrier and scenario followed by the msgId of the send it
  answers, which both pages read from their own result cache, so a re-run on a page
  whose store survived submits a new control rather than a `duplicate`. Over `ws` the
  WS server refuses that frame before any relay, which stays a unit pin of the
  server.
- `frozen-audience-membership`: `recipient-b` holds its ACK back and closes its
  connection once the send reaches it, which clears the fault. The receipt keeps it
  expected and reports it unconfirmed (D43), and the handle reads `expired`.
  `recipient-b` reconnects only after the send has expired, as the same session.

A fifth scenario, a relay in front of `recipient-b` whose hop list names the relay
while the recipient list names `recipient-b`, is deferred (R-S2c-ii-10): only the
group owner can override the topology, and under `tree` which of three sessions sits
in the middle is a hash of their ids, so no run can pin the relay. A unit pin proves
the hop-versus-recipient property until the harness can place a relay.

The local lane runs these scenarios as the `three-agent family over <carrier>` test,
three pages in one run. The Hetzner manifest
`22-alm-conformance-3-agent.json` (pattern `one-sender-two-recipients`) runs every
carrier's scenarios in one combined recipe per role. Nothing in that combined recipe
orders `recipient-b` arming its ACK hold for the next scenario before the sender's
next send. `recipient-b` arms it once its previous scenario's absence window has
ended, a window that started at the arrival; the sender sends once its own window,
which started at its admission a little earlier, and its receipt read and asserts
are done. The margin is the sender's extra local steps against the arrival latency,
milliseconds rather than a barrier. The local lane runs each scenario with its own
connect, and there the hold lands seconds before the send. A lost race on Hetzner
reddens the scenario (an ACK that should have been held confirms `recipient-b`); it
never makes one green.

The `membership-fence` conformance scenarios (`scenarios/membership-fence/`) run on the
same three agents, over `ws` and `rtc`, in the full scope. Every room send carries the
roster of its sender's cached room snapshot as `targets.rosterVersion`, beside
`minSnapshotVersion`; a received message event's `data` states it as `rosterVersion`
right after `typeId` (absent for a unicast, or for a room send whose sender cached no
snapshot). The roster moves by the self-service membership route the ensure step
already uses: `leave-roster` writes `{ status: 'left' }` for the page's own principal,
which advances the group's roster and snapshot versions, and the next scenario's
`ensure-member` joins it again. The three-agent run starts `recipient-b` only once the
receiver has connected, so the receiver's prologue creates the run's group and owns it:
the roles that leave (`recipient-b`, the sender) are never its only owner, whose own
leave the server refuses `last-owner`. A removed member could not rejoin itself, and
only the owner removes one, so no cell removes.

- `fenced-delivery`: the sender's room send reaches both recipients. Nothing moves the
  roster inside the cell, so each recipient reads the group snapshot over HTTP after
  the arrival (`read-roster`, `GET .../groups/<groupId>`) and waits for the arrival of
  the cell's type whose `rosterVersion` equals that read's `body.group.rosterVersion`
  (`roster-stamp`, a `{resultCache...}` token in `contains`).
- `fenced-catch-up`: the sender floors its first send `{ aboveCurrentBy: 1 }` and waits
  for the `al.control.nack.v2` that refuses it `not-yet-in-sync`; only then does it send
  the cue, an unfloored second send. Over `rtc` a recipient refuses the copy and the
  sender commits its NACK. Over `ws` the server retains the send as a pending admission
  and answers an advisory NACK, which the sender leaves not handled, so the wait matches
  the NACK's arrival with no outcome. `recipient-b` leaves the group once the cue reaches
  it, which moves the snapshot to the floor: over `rtc` the sender's next copy is
  admitted, over `ws` the server's replay finds the floor met and delivers the retained
  send. The receiver receives the floored send once (`received-floored`) and nothing
  beyond the two sends. Over `rtc` the receiver first waits for its own
  `admission-outcome` refusing the floored send `rejected` with a reason starting
  `not-yet-in-sync`.
- `fenced-rejection` (`ws` only): the sender leaves the group and then sends. The WS
  server, at or beyond the send's roster, finds the sender no longer an active member,
  refuses the send and NACKs it `membership-fenced`. The sender waits for the committed
  NACK, observes the handle `rejected` and asserts `failure.kind: 'relay-rejected'`,
  `relayRejection.relay: 'trusted-server'` and `relayRejection.reason:
  'membership-fenced'`; neither recipient receives the send. Over `rtc` a sender's own
  room authority refuses its send once its cache holds the leave, before any frame
  leaves the page, and the harness holds no page's inbound group-state stream, so the
  receiver's fenced NACK over RTC stays a unit pin.

The hosted manifest 22 withholds the three cells, so it stays as recorded: its combined
recipe keeps one prologue for every scenario, so a member that left would miss every
later cell.

The `leader-ack` conformance scenarios (`scenarios/leader-ack/`) run on the same three
agents, in the full scope, and prove a room send that asks `ack: 'group-leader'`. The
receiver owns the run's group, so its own page may appoint itself the room's director
with `director.appoint`, and it ends an appointment of its own with `director.resign`.
The RTC origin resolves the leader from the room snapshot its own page holds, so before
it sends the sender polls `director.status` with `refresh: true` until
`directorStatus.active` reads what the cell needs.

- `leader-confirms` (`ws`, `rtc`, `rtc-with-ws-fallback`): the receiver appoints itself;
  once the sender reads the director active, its room send asks for the leader. The
  receiver receives it once and confirms it, `recipient-b` never receives it, and the
  receipt reads `acknowledged` in the `leader` mode with the receiver alone expected.
  The receiver resigns after its window.
- `no-leader-refused` (`ws`, `rtc`): the receiver resigns any appointment of its own;
  once the sender reads no active director, the send ends `rejected`. Over `rtc` the
  origin refuses it from its own snapshot: `failure.kind: 'refused'`,
  `failure.reason: 'no-leader'`, no carrier attempt. Over `ws` the server NACKs the one
  attempt: `failure.kind: 'relay-rejected'`, `failure.rejection.relay:
  'trusted-server'`, `failure.rejection.reason: 'no-leader'`. Neither recipient
  receives it.
- `leader-outside-list` (`ws` only): the receiver appoints itself and the sender lists
  `recipientPeer: 'recipient-b'` alone, a list that leaves the leader out; the server
  NACKs the send `no-leader` as above, and neither recipient receives it. The page
  resolves `recipient-b` to the one other live session of another principal that is
  not the room's leader.

The hosted manifest 22 withholds the leader cells too, so it stays as recorded.

The `claim` conformance scenarios (`scenarios/claim/`) run on the same three agents, in
the full scope, and prove an exclusive send's claim on its resource key. Each cell
names the resource `claim-<carrier>-<scenarioKey>`, so every send of the cell meets on one
key and no cell meets a key another carrier's cell may still hold. A recipient role may
send: `recipient-b` sends on its own connection, and its handle id names the role.

- `claim-first-wins` (`ws`, `rtc-with-ws-fallback`): the sender's exclusive room
  broadcast with `ack: 'all-logical-recipients'` is confirmed by `receiver` and
  `recipient-b` in the receipt window, and its `attemptCarriers` reads `['ws']` on both
  carriers, since an exclusive send takes WS under every strategy but `rtc`. Once
  `recipient-b` has received that message, it sends its own exclusive broadcast on the
  same resource and reads the verdict `rejected`: `failure.kind: 'relay-rejected'`,
  `failure.rejection.relay: 'trusted-server'`, `failure.rejection.reason:
  'held-by-other'`, one attempt. `recipient-b` then reads that no second copy arrives for
  the rest of its window, so its page stays until its ACK of the exclusive claim has left.
- `claim-expires-reclaims` (`ws` only): the sender holds an exclusive claim with `ttlMs: 3000` and pins
  no receipt, since its short exclusive claim may end `acknowledged` or `expired`; its evidence is
  its admission and receiving the reclaim. `recipient-b` receives that send, holds
  3500 ms past it as a `messages.received` absence (no second copy arrives), and its own
  exclusive send on the resource is admitted and delivered to the sender and the receiver;
  it reads its receipt `acknowledged` after its own absence window.
- `claim-refused-on-rtc` (`rtc` only): the RTC origin refuses the sender's exclusive
  send, which ends `rejected` with `failure.kind: 'refused'`, `failure.reason:
  'unsupported'` and no carrier attempt.

The hosted manifests 18 and 22 withhold the claim cells, so they stay as recorded.

The `cross-carrier-duplicate` conformance scenario replays in both orders over
`rtc-with-ws-fallback`, and its receiver waits for the `admission-outcome` that
refuses the second copy as `not-handled`/`duplicate`. Both orders prove that
refusal: in `rtc-then-ws` the second copy is the WS-carried multicast room
envelope, which the api-v1 WS server routes to the room's other members, so the
receiver refuses it on carrier `ws`. The Hetzner two-agent manifest runs both
orders.

The `ordering-resync` conformance scenario runs over every carrier. The sender sends seq 1, then
seq 300 on the same ordering key, a gap wider than the repair window, and the receiver receives the
first send once and never the second. The verdict on the gapped send is asserted where it is made.
Over `rtc` and `rtc-with-ws-fallback` the receiver is that hop: it waits for its own RTC
`admission-outcome` refusing the send as `not-handled`/`resync-required`. Over `ws` the WS server
is that hop: it keeps its own ordering track, refuses the gapped send without relaying it, and NACKs
the sender, so the sender waits for its `rallar.browser.alm.outbound_diagnostics`
`control-admission` of that `al.control.nack.v2`, pinned on the gapped send's msgId through a wait
result reference. The sender admits that NACK as the word of its trusted server and states the
relay rejection (`relayRejection: { relay: 'trusted-server' }`); the send requested no ACK, so its
handle is already `transport-accepted` and keeps that state. When the lane's catalog input names
`recoveryOwner: 'record'`, the receiver's connect carries `rallar.recoveryOwner: 'record'` (below) and the
RTC receivers add two waits on `rallar.browser.alm.storage` for the one `recovery-owner-invoked` event:
`recovery-owner-invoked` matches the event's kind and the cell's ordering key, `recovery-owner-cursor`
the cursor it handed the owner (`lastContiguousSeq: 1`, `expectedSeq: 2`, `observedSeq: 300`, carrier
`rtc`); the sender's peer id sits between them in the emitted order, so one `contains` cannot span both.
Over `ws` the relay refuses the gapped send before the receiver sees it, so no owner is invoked there.
The hosted combined recipe shares one connect across its cells and names no owner, so manifest 18 carries
neither the field nor the waits.

The `ordering-gap-repair` conformance scenario runs over the single-hop carriers `ws` and `rtc`
(`ALM_CONFORMANCE_SINGLE_HOP_CARRIERS`) and repairs an in-window gap by range. The sender sends seq 1 and
proves it left (`observe-transport-accepted-1`, asserted `transport-accepted` or `acknowledged`), arms the native hold of its type on each carrier the cell can hold,
sends seq 2, then holds that one message by the id its send returned (`hold-message-2-<carrier>`, a
`fault.inject` whose `match.msgId` names `{resultCache.<send-2>.value.msgId}`) and releases the hold of
the type, so seq 3 passes while seq 2 stays held across every retransmission. The hop reads the gap and
NACKs the range `2-2`: over `ws` the relay, over the RTC carriers the receiver. The sender waits for its
`control-admission` of that `al.control.nack.v2` as `committed`, pinned on seq 3's msgId (`gap-nack`), then for
the `commit-phases` of the retransmission the hint dispatched (`repair-dispatch-2`: seq 2's msgId, the cell's
typeId, `"origin":"repair"`), and only then releases the message hold: under the hold the original is
resubmitted as well, so a release right after the NACK would deliver seq 2 even if the hint were never served.
The receiver receives the first send once, all three within the send budget, and never a fourth. Over `rtc` the
receiver is the hop that buffers seq 3 behind the gap, and it proves the order with two waits on
`rallar.browser.alm.inbound_diagnostics` for the one `claim-settled` event of the `release-buffered` claim that
handed seq 3 to its channel: `release-buffered-track` matches the effect id's head `release:<ordering key>%3A`
(the cell's track), `release-buffered-3` its tail `%3A0:3` followed by the `null` identities and
`"payloadKind":"release-buffered"` (seq 3 of epoch 0); the sender's peer id sits between them inside the
URI-encoded track key, so one `contains` cannot span both. Three arrivals and a released seq 3 together say seq
3 waited in the ordered-delivery buffer until seq 2 arrived. Over `ws` the relay is that hop: it buffers seq 3
and releases it after the repaired seq 2, out of the receiver page's sight, so the `ws` receiver sees the three
arrive in order and carries no release wait (had it reordered them itself, it would have had a release of its
own to show). The cell has no `rtc-with-ws-fallback` variant: a hand-over moves
one message of an ordering track to WS, whose relay never saw the track's other messages and gates the one it
receives as its own gap, so the hand-over of an ordered message is a carried limit, not a cell.

The `repair-exhausted` conformance scenario runs over every carrier. It is the gap repair whose message hold
is never released: after the admitted NACK the sender sends seq 4, whose arrival reports the gap a second
time. One arrival raises one hint, whatever controls it sends, so seq 3's report spent the budget of one
retransmit (`maxRepairs`) and seq 4's finds it spent. The sender
then observes seq 2's handle `failed` and asserts `failure.kind: 'skipped'` with `failure.reason:
'repair-exhausted'`; the receiver receives the first send once and proves the absence of a second, since
seq 3 and seq 4 wait for a seq 2 that never arrives. The hold stays until the page ends: a release would let
the second frame reach the receiver inside its absence window. Both cells are withheld from the hosted
manifests, as the checkpoint cells are; they run in the local lane and in the observation's full read.

The `not-yet-in-sync` conformance scenario (`not-yet-in-sync-expires`) runs over
`rtc` and `rtc-with-ws-fallback`. Its receiver first waits for its own RTC
`admission-outcome` refusing the send as `rejected` with a reason starting
`not-yet-in-sync`; that refusal writes no rows, sends the sender a NACK and
refreshes the receiver's room once. The send states `{ absolute: 999999 }` with
the 7.5 s expiry lifetime; the receiver proves absence for the rest of that
lifetime and past it, and the sender observes `expired`. Delivery once the
version advances is `fenced-catch-up`'s.

The fallback family runs over `rtc-with-ws-fallback` only (D56, D63–D66), two agents each.
`fallback-within-deadline` (smoke) arms an RTC `drop` fault on the sender's own frames of the send until
the scenario ends; the third consecutive `not-ready` attempt hands the message to WS, the sender observes
`acknowledged` with `attemptCarriers` containing `rtc` and `ws` and `attemptOutcomes` containing `not-ready`
(an admission-time fallback leaves no `not-ready` row), and the receiver delivers it once and
waits for its `admission-outcome` `committed`/`admitted` on carrier `ws`. `receipt-exhausted-fallback`
(full) holds the receiver's RTC ACKs; the RTC receipt runs out of retries after about 8 s and hands the
message over, the receiver refuses the WS copy as `not-handled`/`duplicate` and, its first admission
having been on RTC, sends its own ACK again over WS (R-S3b-1), and the sender observes `acknowledged`
within a 15 s budget. `no-fallback-after-deadline` (full) holds the
receiver's RTC ACKs on a 7.5 s send, which expires before the RTC receipt budget ends: the sender
observes `expired`, and no `admission-outcome` on carrier `ws` reaches the receiver for the whole window.
The lifecycle keeps one attempt row per send-prepared row, overwritten on each retry: `attemptOutcomes`
shows the last outcome per row, not a count of retries, so `fallback-within-deadline`'s three consecutive
`not-ready` RTC attempts settle inside one attempt entry (`attemptOutcomes` reads `[not-ready, sent]`, not
three `not-ready` entries).

The congestion cells run in the two-agent family, in the full scope, after its other cells (D187). Each holds the
sender's own carrier at its high watermark with a transport `fault.inject` of action `backpressure` on the cell's
`typeId`, `remaining: 'until-cleared'`, sends one room send with `ack: 'receiver'`, and releases the hold with
`remaining: 0`; it reads the page's counter of its decision from `stats` (`rallar.congestion.<counter>` above 0),
which no earlier cell of the family raises. `backpressure-hands-over` (`rtc-with-ws-fallback`) holds the RTC leg and
sends `reliability: 'best-effort'` (priority 0; the harness's channel purposes default to at-least-once): the RTC
leg is refused `congested` and the send handed to WS at admission, so it ends `acknowledged` with `attemptOutcomes`
`[refused, sent]`, `attemptCarriers` `[rtc, ws]` and `attemptRefusalReasons` `[congested]`, and `handedOver` above
0; the same send also counts in `dropped`, since the RTC admission drops it first. The receiver delivers it once and
reads its `admission-outcome` `committed`/`admitted` on carrier `ws`. `backpressure-refused` (`rtc`) sends the same
best-effort send, which ends `rejected` with `failure: { kind: 'refused', reason: 'congested' }` and `attempts` 0,
with `dropped` above 0, and the receiver proves for the whole window that nothing reaches it.
`backpressure-deferred` (`ws`, `rtc`) sends `reliability: 'at-least-once'` (priority 5, which `drop-low` keeps),
waits on the outbound diagnostics topic for the page's `congestion` `defer` of that send (`cause` `backpressured`,
`priority` 5, the `msgId` the send returned), reads the send's receipt while it is held and asserts `submitted` is
`false`, releases the hold, and observes `acknowledged` with `attemptOutcomes.0` `sent` and every row `sent`
(`matches` `^sent$` on `attemptOutcomes`), and `deferred` above 0. There is one attempt row per next hop of the
carrier (an RTC sender keeps the peers of earlier cells as ready hops), each overwritten on its retry, so the
counter, not `attemptOutcomes`, shows the `not-ready` submissions. Under `rtc-with-ws-fallback` three of them would
hand the send to WS, so the cell runs on single carriers. Hosted manifest 18 withholds all three, so it stays as
recorded. The cells live in `conformance/alm/scenarios/congestion/`.

The addressed family runs on two agents, in the full scope, as its own Playwright test per carrier (R-S3c-ii-2,
R-S3c-ii-5); each scenario declares it as its `laneFamily`. The lane proves the addressee's receipt, not the
addressing: on two agents a room send yields the same receipt, so the addressing is pinned by unit tests.
`ws-unicast-receipt` (a historical id: it runs over every carrier: the sender sends a `command` to
`toPeer: 'receiver'`) and observes `acknowledged` under the `receiver` mode with one expected and one
confirmed recipient; its recipe metadata `almReceiptRoles` pins the receipt to the `receiver` role, which the
identity assessment joins to the receiver's session after the run. `unicast-fallback`
(`rtc-with-ws-fallback`) drops the sender's own RTC frames of the unicast until the third `not-ready` attempt
hands it to WS; the sender reads `attemptCarriers` containing `rtc` and `ws` and `carrierFallback`
`{ from: 'rtc', to: 'ws', reason: 'not-ready' }`, and the receiver receives the copy and reads its
`admission-outcome` `committed`/`admitted` on carrier `ws`. `server-command` (`ws` only) sends a `command` to
`toPeer: 'server'` and observes `acknowledged` on the server's own ACK, while the receiver proves for the whole
window that nothing reaches it. `capacity` runs over every carrier: the sender closes, reconnects with
`rallar.almVolatileLimits` `{ maxAdmissions: 1000, maxBytes: 36000 }`, waits 31 s, sends two ≈13.4 KB messages (a
12 000-byte filler) that are admitted and acknowledged, and a third that ends `rejected` with
`failure: { kind: 'refused', reason: 'capacity' }` and `attempts` 0, so no fallback; then it closes and reconnects
without the field, restoring the constants. The close keeps the membership, and the reconnect joins the room again,
so the lowered session counts the platform's own state sync it admits inbound (about 26 KB in 6 entries in the local
lane, larger in a long-lived hosted room) for at most 30 s; the 31 s wait lets it leave the budget before the first
send (R-S3c-ii-9). The limit is three fillers, so the two counted sends alone refuse the third, and the second keeps
at least 9 180 bytes of headroom. Its receiver's window adds one readiness budget and the 31 s wait, since the sender
reconnects and waits before it sends. In manifest 18 the three `capacity` blocks run after every other block.
Two more cells of the family prove the age and track limits over every carrier, and manifest 18
withholds both, so it stays as recorded. `capacity-age` keeps the sender's connection and constants and sends one
message with `ttlMs` `AL_VOLATILE_SESSION_MAX_AGE_MS + 1_000` (301 000): it ends `rejected` with
`failure: { kind: 'refused', reason: 'capacity', limit: 'age' }` and `attempts` 0, and the receiver proves for the
whole window that nothing reaches it. `capacity-tracks` closes, reconnects with `rallar.almVolatileLimits`
naming the four production limits but `maxTracks: 2` and sends three at-least-once messages with `ack: 'receiver'`, each `seq` 1 on an ordering key of
its own (`alm-<carrier>-capacity-tracks-<index>`), so each would open one track: the third ends `rejected` with
`limit: 'tracks'` and `attempts` 0; right after the refusal, while both sends still hold their tracks, it reads
`stats` and asserts `rallar.alm.usage.tracks` 2, `rallar.alm.limits.maxTracks` 2 and `rallar.alm.overloaded` false
(the only ledger reading a lane cell asserts at a bound); the first two are acknowledged; then it reconnects without
the field. A
received message never opens a counted track, so it needs no wait for the rejoin's state sync, and its receiver's
window adds only the readiness budget. The three cells live in `conformance/alm/scenarios/volatile-bound/`.

The same-context family runs, in the full scope, as the `same-context family over <carrier>` Playwright test. Its
scenarios declare a fourth role, `successor`: a second page opened in the sender's own browser context, so it shares
the sender's IndexedDB and the `auth.session` in `localStorage`, under a control agent of its own. That page skips the
login screen, and its recipe connects with `rallar` `{ username: '', password: '', restoreSession: true }`, so it
restores the sender's session rather than signing in afresh. Over the RTC carriers its connect waits for one ready
peer, as the sender's and the receiver's do, since both pages are one session and so one peer. The two pages are never connected at once: the
server keeps one WebSocket per auth session and a second upgrade closes the first with `connection-replaced`, after
which the first page reconnects and replaces the second. The lane therefore starts the receiver, runs the sender's
recipe, closes the sender's page from Playwright, and only then runs the successor's recipe, whose prologue waits out
the owner page's last work lease before its connect; no control command closes a page. For `flush-on-hide` the lane
ends the sender's page instead by firing its `freeze` event, waiting 250 ms and crashing it over CDP (`Page.crash`), so
no `pagehide` listener and no later timer of that page runs. No `reset` runs on a successor
page, since it would clear the storage both pages share. Each scenario opens its own successor, which owns the session
for the next one. The Hetzner entries select their scenarios by lane family (`two-agent` and `addressed` for manifest
18, `three-agent` for manifest 22), so neither carries this family: a hosted agent has no second page in its context.

`messages.observe` waits on the in-page message handle; `messages.receipts` reads
its current lifecycle without waiting. The shared states are `submitted`,
`rejected`, `pending-authority`, `accepted`, `queued`, `transport-accepted`,
`acknowledged`, `expired`, `superseded`, `failed`, `cancelled`, and `unobservable`.
Carrier settlements update the handle directly. Observations include
`submitted`, `attempts`, `attemptOutcomes`, `attemptCarriers`, `relayRejection`, `carrierFallback`, `failure`,
`receiptMode`, `confirmedHopPeerIds`, `unconfirmedHopPeerIds`, `expectedRecipientPeerIds`,
`confirmedRecipientPeerIds`, `unconfirmedRecipientPeerIds`, `reason`,
`attemptRefusalReasons`, `backpressured`, `enqueued`, and `durabilityDowngrade` (`{ requested, cause }`, present
only on a send its channel downgraded to volatile because storage could not hold it). `attempts` counts every attempt
row, including a carrier admission that never reached the transport: an `unroutable`
leg, or a `refused` leg the fallback carrier took over. `attemptOutcomes` lists
the outcome of every settled row in attempt order. `attemptCarriers` names the carrier of each of
those settled rows, index for index, so a hand-over reads `rtc` rows then a `ws` row. `attemptRefusalReasons` lists
the reason of every `refused` row in attempt order, so a leg refused `congested` and handed to WS names its cause. `receiptMode` is the latest
receipt's mode (`hop`, `subtree` or `receiver`), absent until a receipt
settles. Under `hop` and `subtree` the recipient lists equal the hop lists.
Under `receiver` the recipient lists count the frozen logical audience:
`expectedRecipientPeerIds` is that audience (never the origin), and
`acknowledged` means every one of them confirmed; an origin alone in its room is
acknowledged at admission with all three lists empty. The hop lists are then the
local hop view of the origin: `confirmedHopPeerIds` are the next hops whose own
completion ACK arrived, `unconfirmedHopPeerIds` the rest of the next hops the
send went through. A relay in front of a recipient is a confirmed hop while the
recipient is a confirmed recipient. A WS origin names no hop, so both hop lists are
empty there. `relayRejection` is present once a hop refused a retained send with
an admitted `resync-required` NACK: `{ relay: 'peer', peerId }` for an RTC hop or
an addressee, or `{ relay: 'trusted-server' }` for the WS server, which is never
named. The rejection ends the send `rejected` and its receipt with it, so a
multi-recipient receipt keeps the recipient evidence it had at that moment. A send
that tracks no receipt is already `transport-accepted`, which is terminal for it,
when the NACK arrives: it keeps that state, and the rejection lands as evidence
only, in `relayRejection`.

`failure` is present once the send ended `rejected`, `failed` or `expired`, and says why, typed:
`refused` with the carrier's `reason` (`capacity`, a session over its volatile bound, never hands
the send over; `congested`, a carrier at its high watermark with no fallback carrier left), `relay-rejected` with its `rejection`, `admission-failed`, `storage-unavailable` with
its `cause` (`missing`, `open-failed`, `reset-blocked`, `quota`, `closed`, `evicted` or
`transaction-failed`: the durable store wrote nothing), `skipped` with its
`reason`, `unroutable` with its `reason`, `attempt-failed` with its `outcome`, `receipt-exhausted`
with its `cause` (`budget`, or `hop-refused` with `hopPeerId` and `nackReason`), or `expired`.
`reason` keeps the prose; a receipt-less send refused late keeps `transport-accepted` and no failure.

`carrierFallback` is present once the strategy handed an admitted message to its second carrier (D56):
`{ from, to, reason, atMs, detail }`, with `reason` one of `not-ready`, `not-yet-in-sync-exhausted` and
`receipt-exhausted`. A refusal at admission, such as the volatile bound's `capacity`, is no hand-over, so it
leaves `carrierFallback` absent and `attempts` at 0. A `congested` refusal under `rtc-with-ws-fallback` is a
hand-over at admission, not of an admitted message: it leaves `carrierFallback` absent and a `refused` RTC row before
the WS row.

`backpressured` is true when a carrier
refused admission for its own rate limit or open circuit, never when it simply
had no peer: it counts admission refusals (`rate-limited`, `circuit-open`), not
channel backpressure, which reads as a `congested` refusal or deferral and the
`stats.rallar.congestion` counters; `enqueued` is true once a durable admission put the message in a
carrier queue.
A terminal state ends a wait even when it was not requested; a true timeout
reports the last state. A send waits for admission until the earlier of the
command's timeout and absolute deadline (5,000 ms when it names neither, zero
once the deadline has already passed), independently of the message TTL.

`messages.cancel` stops the owner's remaining attempts for a live handle;
it preserves terminal evidence and cannot recall a submitted frame. Handles
survive transport reconnects. The ledger reads every handle through the browser
session's delivery registry, which alone bounds how long an observation is kept.
The registry applies its bounds only when a later send opens a new delivery, and no
timer evicts anything: that send drops terminal handles whose terminal state is more
than 60 seconds old, then drops the oldest handles beyond 512 entries (terminal ones
first, and a live one ends `unobservable` for its own waiters). A terminal handle
therefore stays readable until the first send after its 60 seconds. Once the
registry drops a handle, including while an observe waits on it, and after a
reload, observe, receipts, and cancel return `unobservable` with no attempts or
hop lists, never an invented failure. The ledger projects handles and performs no
admission-storage polling.

`messages.received` counts inbound messages of a `typeId` (optionally one
`msgId`). It scans the **whole** inbound event log rather than a trailing
window, so a scenario that legitimately produced the same message earlier needs
a distinct `typeId` to say which occurrence it means. A presence claim settles
as soon as `count` is reached; `absent: true` holds the full `windowMs` and then
passes only when fewer than `max(count, 1)` messages arrived.

`fault.inject` schedules a scripted `drop` for the next `remaining` matching
frames on the `ws` or `rtc` carrier; `{ delayMs }` and `not-ready` are `ws` only
(the `rtc` carrier accepts `drop` and `backpressure`), and `not-ready` answers a
matching submission not ready. `backpressure` (either transport carrier)
makes the carrier read its channel at its high watermark when it plans a
matching origination and when it submits a matching frame; each such read
consumes one of `remaining`. The matcher reads the
**AL envelope**, not the recipe's own fields: `match.typeId` compares against
`payload.typeId`, `match.msgId` against `id.msgId` — or, for an ACK, NACK or
repair, against the original message id parsed out of the control payload's own
`resource` JSON — and `match.controlType` selects the ACK, NACK or repair type
id. A top-level `typeId` never matches. The fault's observations are not
readable from a recipe in this release, so a fault's effect can only be inferred
from what the receiver did or did not get.

`fault.inject` with `carrier: 'storage'` faults the AL-owned IndexedDB
operations instead: `match.owner` is `al-admission` or `al-work`, and
`match.kind`, when present, narrows it to one operation kind (the kinds
`storage.counters` reports). `action: 'fail'` rejects the operation with an
`UnknownError` `DOMException`, `action: 'quota'` rejects a write (`write`,
`work-write`, `work-reserve`, `work-release`, `work-cleanup`) with a
`QuotaExceededError` and lets reads through, and `{ delayMs }` holds the
operation. A rejection's message names its `faultId`
(`Scripted storage quota fault <faultId>`, `Scripted storage fault <faultId>`),
so the `detail` of the storage failure a store reports on
`rallar.browser.alm.storage` reads back to the fault. The decision lands before the operation's own request:
before its transaction opens, before a read inside a read session that is already open, or between a reservation's
finished read and its write, so a fault never leaves half a write. The operation is still counted by `storage.counters`. Replacing
the same `faultId` with `remaining: 0` releases it, and `close` clears every
storage fault with the transport faults.

`storage.counters` reads the AL-owned IndexedDB operation counters as
`{ total, byOwner: { 'al-admission', 'al-work' }, byKind, workProbeCount,
workNonProbeCount, reset }`, and `reset: true` reads and then clears them.
`reset` echoes whether this reading cleared the counters, so the next reading
counts from zero. `workProbeCount` is the durable owners' idle probes —
`byKind['work-page']` plus `byKind['work-probe']` — and `workNonProbeCount` is
every other `al-work` operation. The counters count IndexedDB only; a memory
store never moves them.

A storage window is two readings around the work it measures: a
`storage-window-open` reading with `reset: true`, the scenario's commands, then
a `storage-window` reading without a reset that the assertions read (each
command id carries the scenario and role). `volatile-default` asserts
`byOwner.al-admission` and `workNonProbeCount` equal to 0 on the sender and the
receiver, with the probes reported beside the zero (D55); `durable-opt-in` sends
with `durability: 'local-inbox'` and asserts `byOwner.al-admission` above 0 on
both pages. The receiver's window closes after its arrival and before a trailing absence
window, so its acknowledgement has left before the scenario ends. The scripted storage observer and transport fault
port are attached only when the active connection names an application, so both
`storage.counters` and `fault.inject` refuse a connection without one instead of
reporting zeros.

`storage-unavailable` runs over every carrier and holds a `quota` storage fault on both owners of the sender's page:
`al-admission` writes and every `al-work` write, each under its own fault id. Both ids start with the cell's type id
followed by `.quota-`, which no other cell's ids share. The work owner is held too because a work release that commits
records a recovery point: during the hold no write of the page can read a store healthy. Under the hold the first
send, on the default channel, must fail with `failure.kind: 'storage-unavailable'`, `failure.cause: 'quota'` and
`submitted: false`; the second, with `onStorageUnavailable: 'volatile'`, must be admitted with `enqueued: false` and a
`durabilityDowngrade` of `{ requested: 'local-outbox', cause: 'quota' }`. A wait between them reads a store's
`health` turn `failing` with a `lastFailure` whose detail names one of the cell's fault ids. Both holds are then
released, the third send must be admitted with `enqueued: true`, and a last wait reads a store `healthy` with that
failure still its last. The receiver gets the second and the third payload, each naming its carrier, and never the
first. Two residuals remain. The fault port is page-wide and the rtc and fallback cells share one overlay store, so
the waits are tied to the cell, not to a store: they cannot show which store turned, nor that a store left alone stayed
healthy. And the healthy wait proves only that some store recovered after the release: a release of an earlier cell's
leftover rows can read it healthy, so the third send's own commit is proven by `assert-enqueued-3`, not by the wait.

`durable-takeover` runs over every carrier in the same-context family. The sender's page holds its carrier with the
same native hold as `delivery-reload`, sends one durable original with `ack: 'receiver'` and a `ttlMs` of the
absence window plus 60 s (above one 10 s lease, the 19.1 s recovery bound and a whole successor connect), and proves
it admitted, enqueued, retained and unsubmitted. Over `rtc-with-ws-fallback` it then polls its receipt until a WS
attempt follows the hand-over to WS, so the WS row is committed before the page ends. The lane then closes that
page. Under the hold the row stays reserved until its lease ends, so a successor's prologue first waits out one
lease and a margin (an absent wait on a topic nothing emits) before it connects: its takeover's first batch then
claims the row rather than finding it leased. The successor connects with the restored session, waits for the one
`recovery` of the store that held the original (`browser-rtc-overlay` over `rtc`, `browser-ws-client` otherwise)
reading `restored`, the store id embedding the session its own connect restored, and asserts that outcome's
`claimed` above 0. The receiver waits for the carrier-tagged original over the sender's connect plus the original's
lifetime, then proves for an absence window that no second copy arrives. A takeover while the owner's lease still
stands, recovered by a later batch at the lease end plus at most 19.1 s, is not run by the lane: that path claims in a
batch that reports nothing, and the server keeps one socket per auth session, so the successor cannot connect before
the owner's page is gone.

`checkpoint-recovery` runs over every carrier as a paired reload, like `delivery-reload`. The sender holds its carrier,
resets the storage counters, sends one `local-checkpoint` original with `ack: 'receiver'` and the same lifetime as the
takeover's, proves it admitted, enqueued, retained and unsubmitted, waits out the checkpoint interval (1 s) and a
margin, and asserts the counters' `byKind.write` above 0: the send path writes nothing, so that write is the
interval's checkpoint. It then reloads; the reload's own `pagehide` flush is best effort and not what the cell proves.
The reloaded page waits out one lease (the checkpoint holds the row reserved), reconnects with the restored session,
reads the old handle `unobservable` and the checkpoint store of the held original `restored` with `claimed` above 0.
The receiver proves the original absent before the reload, receives it once after, and proves no second copy.
`checkpoint-lag` is described with the storage diagnostics. `flush-on-hide` runs over `ws` and `rtc` in the
same-context family: the owner page holds its carrier, sends one `local-checkpoint` original and ends its recipe at
once, inside the interval; the lane fires the page's `freeze` event and crashes it, and the successor restores the
checkpoint store with `claimed` above 0. A headless page is never hidden and CDP `Page.setWebLifecycleState` freezes no
visible page, so the cell drives the event the flush listens for, not a frozen page; that the write is the flush's and
not the interval's rests on the lane ending the page inside the interval. Over `rtc-with-ws-fallback` a held original
moves to the WS lane at no known moment, so the cell does not run there. All three are `full` only and withheld from
the hosted manifests, so manifests 18 and 22 are unchanged.

`agent.reload` asks the control agent to reload its page and resume the run. The
agent records the run id, its agent id and the command ids it already completed
in `localStorage` under `rallar-bb-agent-resume`, replays that record on
re-register, and the coordinator continues from the next command. On the
`spa-local` surface nothing reloads and the command only records the request.

### The `messages.ws` Connect Transport

`rtc.connect` accepts `transport: 'messages.ws'` beside `realtime` and
`messages.rtc`. It subscribes the typed inbound channel over the WebSocket and
opens no RTC lane, which is what lets the `ws` carrier run without a peer. It is
a connect-only transport: `rtc.send` accepts `realtime` and `messages.rtc` only.

### The lane-only `rallar.almVolatileLimits` connect field

`rtc.connect.rallar.almVolatileLimits` names `maxAdmissions` and `maxBytes` and may name `maxAgeMs` and `maxTracks`,
each a positive integer, and nothing else; any other shape fails the connect with
`rallar.almVolatileLimits must name maxAdmissions and maxBytes and may name maxAgeMs and maxTracks, each a positive integer.`
An age or track limit the field leaves out reads its constant (`AL_VOLATILE_SESSION_MAX_AGE_MS`,
`AL_VOLATILE_SESSION_MAX_TRACKS`), so a two-field value lowers the count or byte limit alone. It is validated in
the page only: the recipe schema and the control validator treat `rallar` as a free record, so a malformed value fails
its `rtc.connect` rather than the recipe. It lowers the ALM volatile bound (D74) of the session this connect
initialises: the page holds it and hands the browser session a read port that the session reads once, when it
initialises. It is a harness capability, never a `rallar.connect` option. A facade that is already connected keeps the
bound its session read, and a connect that names the field on a live facade has no effect until its next session, so a
recipe closes the connection before a connect that names the field, and closes and reconnects without it to restore
the constants (`AL_VOLATILE_SESSION_LIMITS`).

### The lane-only `rallar.recoveryOwner` connect field

`rtc.connect.rallar.recoveryOwner` is `'record'` or absent; any other value fails the connect. Like
`almVolatileLimits` it is validated in the page only, since the schema and the control validator treat
`rallar` as a free record. `record` declares a recovery owner on the typed channel the connect subscribes
for its `typeId` and `topicId`: the harness's recording owner, which states each invocation as a
`rallar.browser.messages.recovery_owner_invoked` diagnostic carrying the cursor it was handed. The browser
states the same invocation as `recovery-owner-invoked` on `rallar.browser.alm.storage`, which is what the
`ordering-resync` receiver waits for. A connect with a `messageSelector` subscribes the lanes directly and
opens no channel, so it declares no owner; absent, the channel declares none and a message the receiver can
no longer order is dropped, as a product channel does by default.

### A `fault.inject` that holds one message

A transport `fault.inject` whose `match.msgId` names `{resultCache.<commandId>.<path>}` resolves the token
against an earlier command's result before the fault is armed, as `messages.control` resolves its
identities; the usual case is the `msgId` a `messages.send` returned, which holds that one message across
its retransmissions while every other frame of the type passes. A token no earlier command returned fails
the `fault.inject`.

## RTC Connect Readiness

`rtc.connect.readiness` applies the readiness policy for the selected
transport before the command returns successfully. Its defaults are
`minReadyPeers: 1`, `timeoutMs: 5000`, and `intervalMs: 100`. The command-level
timeout should be longer than the readiness timeout so connection setup does
not consume the readiness budget.

For `realtime`, the `browser-rallar` runtime used by browser control agents and
`rallar-remote-browser` distributed runs retains the peer-health readiness
loop. Missing peers trigger an immediate exact-room state and topology refresh
and no more than one refresh per second afterward. Refresh receives
cancellation and the remaining readiness deadline; transient refresh errors
are retried, permanent errors fail, and only later health with enough ready
peer IDs satisfies readiness.

For `messages.rtc`, the runtime performs one exact-room refresh and then
delegates to the product's canonical `rtc.waitForRoom` operation. Success
requires an accepted layout and an `open` or `partial` room transport with the
requested minimum ready peers. This path does not poll global health and does
not retry the refresh. `messages.ws` opens no RTC lane and normally has no RTC
readiness request.

The command or its active `configure` command must therefore resolve either an
exact `roomRef`, or `applicationId` plus `roomId`; omitted `workspaceId`
defaults to `default`. Preflight emits a warning rather than an error when that
identity is not recipe-resolvable because simulated providers and external
runtime configuration can remain valid. `refreshRoom` and `waitForRoom` are
internal runtime bridge operations, not recipe commands or public
command-schema fields.

## RTC Send Boundary And HTTP Result Evidence

`rtc.send` has no `expect` field on the control path: the command schema and
`validateRallarBlackBoxTestCommand` reject it, because no agent runtime ever
evaluates it and a control-dispatched recipe carrying it would validate green
while asserting nothing. The `RallarBlackBoxTestRtcSendCommand.expect`
TypeScript field exists only for the in-process black-box-runner adapter,
which calls `runtime.execute` directly and records runner-side expectations.
Distributed delivery expectations belong in `wait` and `assert` commands.

`http.request` results record `url`, `status`, `statusText`, `ok`, the full
response header record, and the decoded body. Every recorded result value,
failure detail, and the mirrored `rallar.bb.http.response` event passes the
runtime redaction pipeline, so sensitive header and body names (authorization,
cookie, token, ticket, and the other default key substrings) appear as
`<redacted>` in results, events, failures, and artifacts. Header evidence is
therefore assertable from recorded results without extra capture options.

## Wait Absence

`wait` with `absent: true` asserts non-delivery: the agent holds the full wait
window (`timeoutMs`/`deadlineEpochMs`, default 5000 ms — an absence claim is
only as strong as the time spent listening), then scans the whole event
buffer once. Any matching event — buffered before the wait started or arriving
during the window — fails the command with
`RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED` and the offending redacted event in
the result value and error details; an empty scan succeeds with
`matched: false, absent: true`. Past events match by design, exactly like
positive waits. `absent` accepts only `true`; schema and control validation
reject other values. Semantics mirror the black-box-runner's `expect.absent`
waits. Pair every absence wait with a same-scope positive control delivery so
a broken transport cannot masquerade as proven absence. Evaluation lives in
`wait/wait-for-event.ts`; match semantics live in `wait/wait-event-match.ts`.

## Recipe Barrier

`barrier` stops an agent until every participant of the started distributed run has reached the same
`barrierId`. The agent records `rallar.bb.barrier.arrived` (`barrierId`, `timeoutMs`, `participants`),
which its control client forwards like any event, and completes on the control server's
`rallar.bb.barrier.resolved`. Absent `participants`, every agent the run started takes part; present,
the role names resolve through the run's start links. The server opens the window at the first
arrival and decides once: `released`, or `failed` with `timed-out`, `participant-failed` (a missing
participant's run already failed), `not-a-participant`, `conflicting-arrival` (another `timeoutMs` or
participant set), `unknown-participant-role` or `no-distributed-run`, naming the arrived and missing
agents. A late participant hears the recorded verdict; a late outsider, or a late arrival naming
another `timeoutMs` or participant set, fails alone with `not-a-participant` or `conflicting-arrival`
while the recorded verdict stands for the participants. The agent waits `timeoutMs` plus a 10 s grace
and fails `RALLAR_BLACK_BOX_BARRIER_TIMEOUT` (naming the barrier, the window and the grace) only when no
resolution came; a failed resolution is `RALLAR_BLACK_BOX_BARRIER_FAILED`. When the recipe deadline
ends the wait first, the barrier fails `RALLAR_BLACK_BOX_RECIPE_TIMEOUT` with the deadline, and a
cancelled recipe leaves it `cancelled`. A barrier id is single-use per control run
(`RALLAR_BLACK_BOX_BARRIER_REUSED` on the same page). Barrier state is in-memory on the control server:
a restart forgets open barriers. Outside a control agent nothing resolves the barrier.

Triage. Barrier state is keyed by control run and barrier id, not by distributed run: a second
distributed run reusing a control run id (an operator `--control-run-id` override, or a re-dispatch
with an explicit run id) hears the first run's recorded verdicts for the same generated ids, so give
every distributed run its own control run id; the hosted workflows already do (`gh-<run>-<attempt>`,
`main-<run>-<attempt>-<manifest>`). One role's failure cascades: every other role then fails the next
`<scenario>-start` barrier with `participant-failed`, so a combined run shows one root failure and a
barrier failure per other role. The cause is the earliest failed command that is not a `barrier`.
The fleet report files every `RALLAR_BLACK_BOX_*` code, barrier failures included, under `readiness`
(its guidance matches `ack` before `barrier`, and each code contains "bl**ack**"), so read a barrier
failure's `error.details.reason`, not the fleet category.

## Assert Operators

`assert` evaluates a dot-path `source` over the runtime evidence roots
(`state`, `config`, `lastResult`, `events`, `messages`, `diagnostics`,
`reports`, `recent*`, `stats`, `failures`, `resultCache.<commandId>`).
Operators:

- `equals` / `notEquals` / `contains` / `exists` — historical semantics kept:
  `notEquals` passes when the path is missing, and `gte` / `lte` accept only
  values that are already numbers.
- `gt` / `lt` / `between` — runner-comparator parity: values and bounds are
  coerced with `Number(...)` and must be finite; `between` takes an inclusive
  `[low, high]` pair and fails on a malformed pair.
- `length` — exact length of an array or string; anything else fails.
- `matches` — regular-expression source tested against a string value, or
  against every member of a non-empty array of strings; any other value or an
  invalid pattern fails the assert instead of throwing.
- `matchesShape` — `json-compare` `compatible` mode: the expected shape is a
  subset the actual value must satisfy with equal values; extra object keys
  and extra array elements in the actual value are allowed.
- `matchesShapeComplete` — `compatible-complete` mode: like `matchesShape`
  but arrays must be complete, so an unexpected array element fails. Extra
  object keys are still allowed in both shape modes.

Failing asserts fail the command with `RALLAR_BLACK_BOX_ASSERT_FAILED`; the
result value and error details carry the redacted `expected`/`actual`
evidence. Evaluation lives in `assert/assert-value-operators.ts`.

## Loop Until Polling

`loop` with `until: 'first-success'` is the distributed twin of the runner's
`http.poll-until`: every attempt runs the child commands in order and stops
the attempt at its first failing child; the loop exits successfully on the
first attempt in which every child succeeds. Between failed attempts the
agent sleeps `intervalMs x backoffMultiplier^n` (optional `backoffMultiplier`
of at least 1, default 1, flat). Exhausting `count`, `durationMs`, or the
command deadline fails with `RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED` carrying
the attempt count and the last failing (redacted) child result.
`continueOnFailure` contradicts until mode and is rejected at every
boundary; `backoffMultiplier` without `until` is rejected too. Pacing
iteration entries record the backoff-aware schedule, so drift/jitter
observability stays valid; configured thresholds still evaluate on success.
Orchestration lives in `loop/loop-until.ts`.

## Group Assertions

Distributed run manifests may declare a `groupAssertions` block evaluated
coordinator-side by the control server after every dispatched recipe result
completed — invariants over the collected evidence of every targeted agent
(`allMatch`, `noneMatch`, `countMatching`, `allEqual`, `allEqualWithin`).
Typed sources are `{ recipeId, commandId, path }`; predicates reuse
`assert/assert-value-operators.ts`, so the agent and coordinator vocabularies
cannot drift. Contract, participation rules, and failure codes live in
`distributed-run-contract.md`; evaluation lives in
`distributed/group-assertions-evaluation.ts` with the schema branch in
`distributed/rallar-black-box-group-assertions-schema.ts`.

### Comparison Vocabulary Boundary

Three comparison vocabularies exist deliberately, and a fourth is prohibited:

- `isSameJsonValue` (`wait/wait-event-match.ts`) — `JSON.stringify` equality;
  the agent-side match primitive behind `wait` matching and the historical
  `equals` / `notEquals` / `contains` assert operators.
- `json-compare` (`CompareJson`) — structural shape modes behind
  `matchesShape` (`compatible`) and `matchesShapeComplete`
  (`compatible-complete`); its `exact` mode matches arrays
  order-insensitively.
- `deepEqualJson` (`distributed/group-assertions-aggregates.ts`) — group
  agreement equality for `allEqual`: object-key-order insensitive,
  array-order sensitive. Explicitly not `isSameJsonValue` (which is
  key-order sensitive via serialization) and not `json-compare` `exact`
  (which is array-order insensitive).

Pick the vocabulary by claim: event matching -> `isSameJsonValue`; shape
containment -> `json-compare` modes; cross-agent agreement ->
`deepEqualJson`. The assertion-outcome parity and group-assertion
conformance suites pin these semantics.

## Validation

Use `validateJsonSchema(schema, value)` from `schema/json-schema-validation.ts`
for lightweight browser-safe validation, and
`formatJsonSchemaValidationErrors(errors)` for operator-facing errors.

`validateRallarBlackBoxTestCommand(value)` from
`control/validate-rallar-black-box-test-command.ts` is the control-path
admission check that the control server, the browser control agent and the
remote-browser adapter share. It reports every issue it finds as `messages`,
and as one line each in `error`, with nested issues prefixed by the path of the
recipe or composite child that holds them; route-ID issues are also returned as
structured `issues`. Missing required fields are reported from the command field
definition, except where a field's own rule words the absence more precisely.
Per-family field rules live beside it in `control/`, and the ALM command rules
in `alm/validate-alm-control-command.ts`. The control path does not admit
`crdt.*` commands.

Recipe format validation is strict: the recipe schema, the control-command
validator and local runtime execution all reject a recipe, including a nested
or inline one, whose `schemaVersion` is missing or is not `1`. There is no
compatibility decision, warning, or conversion for unversioned recipes.

Current automated coverage validates:

- every capability example
- app-local SPA recipe examples
- local recipe fixtures
- composite fixture authoring for `loop`, `parallel`, `wait`, and `assert`
- Manual Rallar recipe snippets
- Flow Builder SPA recipe exports
- Flow Builder black-box-runner scenario exports
- Run Manager command presets
- every shared-test black-box-runner example recipe
- control-server OpenAPI command examples
- control command envelopes
- distributed-run manifest examples
- distributed-run lifecycle states, domain validation, and rollup behavior
- distributed-run barrier synchronization, timeout, disconnect, cancellation,
  and scheduled-start orchestration
- group-member to control-agent matching and target-policy filtering
- recursive schema-authoring hints for child commands inside `loop`,
  `parallel`, `recipe.load`, and `recipe.run`
- composite result flattening, source recipe paths, parent/child trees,
  failure summaries, and redacted display entries
- runtime diagnostic normalization, wait/assert matching, browser-adapter
  ingestion, and known live WS/RTC console warning bridging
- composite conformance recipes, provider rows, live requirements, and compact
  report artifacts
- the v1 golden compatibility corpus for valid recipes, invalid recipes,
  distributed manifests with inline recipes, and representative AI-generated
  examples
- group-assertion contract validation, rollup integration, and a conformance
  case per aggregate with a deliberately-broken control
- JSON examples in the schema compatibility guide

## Compatibility Rules

Treat schema changes as public command-center contract changes.

- Every `rallar-bb-test` recipe must include `schemaVersion: 1`, including
  nested and inline recipes. Missing or unsupported versions are invalid.
- Author or regenerate explicit v1 input before dispatch; no automatic conversion
  or saved-recipe migration is provided.
- Distributed run manifests should include `schemaVersion: 1`, and inline
  recipes inside manifests must include `schemaVersion: 1`.
- Adding optional fields to an existing command is compatible.
- Tightening a field type is a breaking change unless all shipped recipes and
  examples already satisfy it.
- Adding a new command kind requires:
  - a TypeScript command type in `rallar-black-box-test-contracts.ts`
  - its fields in `schema/rallar-black-box-command-fields.ts`
  - capability metadata
  - a command schema branch
  - control-command validation, or an explicit refusal, in `control/`
  - at least one validating example
  - command-center and runtime tests
- Removing or renaming a command kind is breaking and should require an
  explicit migration note.
- Runner scenario schema changes should preserve the generic HTTP/WS/RTC/ASSERT
  boundary. Do not add Rallar-specific facade operations to the runner core.

CRDT command kinds are browser-agent commands, not runner-core operations.
`crdt.open`, `crdt.apply`, `crdt.read`, `crdt.sync`, `crdt.health`,
`crdt.wait`, `crdt.undo`, `crdt.redo`, `crdt.close`, and `crdt.destroy` delegate to the
browser Rallar CRDT facade through the optional runtime `crdt` surface. Runner
scenarios may reference these as `crdt.*` steps only when the selected provider
can forward them to a browser agent.

Composite command kinds are browser-agent orchestration primitives. `loop` and
`parallel` may contain child commands from the same `rallar-bb-test` vocabulary,
but they must stay transport-neutral and bounded by the exported composite
limits. Runtime execution for `loop` is available for sequential repeated child
commands. Runtime execution for `parallel` is available for bounded concurrent
groups with sequential child commands inside each group.

Schema-authoring views and catalog previews should inspect nested child
commands recursively. A top-level `loop` or `parallel` can still require live
Rallar services when a child command uses `rtc.*`, `ws.*`, or `http.request`.
The same recursive rule applies to inline recipes under `recipe.load` and
`recipe.run`.

`loop` and `parallel` results can be normalized with the exported helpers in
`composite-results.ts`. Callers can turn nested composite output into a stable
flat tree order, chronological timeline, parent/child tree, failure summary,
and redacted display entries without knowing runtime internals. Result paths
start at `$`; source recipe paths map back to command templates such as
`$.groups[0].commands[0]` while runtime paths include loop iterations and
parallel group IDs.

Loop results also include load-oriented observability. `value.pacing` records
requested interval/rate, actual iteration timestamps, elapsed time, drift,
jitter, skipped iterations, and cancelled iterations. `value.sends` records
send counts, success ratio, duration statistics, queued/enqueued/backpressure
counts, dropped/replaced payload counts, per-transport failure counts, and raw
send observations when the adapter can expose them. `loop.thresholds` can fail
the parent command with `RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED` when achieved
rate, drift, jitter, send success ratio, or backpressure evidence misses the
configured limits. The `stats` command mirrors the latest loop under
`stats.load` without raw iteration or send observation arrays for SPA and
artifact summaries.

A browser agent's `stats` result also carries its page's session ledger under
`stats.rallar.alm`: `{ usage: { admissions, bytes, oldestAgeMs, tracks },
limits: { maxAdmissions, maxBytes, maxAgeMs, maxTracks }, overloaded }`, read at
the command from `rallar.messages.readUsage()` (D180) — the same block reaches
`health`'s `stats`, the `rallar.bb.stats` event and `latestStats`, so an
`assert` reads it as `latestStats.rallar.alm.usage.admissions`. The block is
absent before the page's connect completes, on a runtime that drives no Rallar
page, and in the control client's periodic stats envelopes and final report,
which read no page. A page answer that is not a whole report fails the `stats`
command, naming each bad field. No command kind is added: a manifest's
existing stats loops record the ledger over time.

Beside it, `stats.rallar.congestion` carries the page's congestion counters,
`{ dropped, deferred, handedOver }` (D186): one count per `congestion` outbound
diagnostic of the page, `drop`, `defer` or `hand-over`, on either carrier and for
either cause. `deferred` counts every message the page held at submission, relay
forwards and controls included, not only its own sends. The counters belong to
the connection: a `close` resets them, and the block is absent while the page is
not connected, in the same places `rallar.alm` is absent. An `assert` reads it as `latestStats.rallar.congestion.deferred`.

`rtc.stream` is the high-rate RTC traffic primitive. Use it when a recipe wants
to model a realtime stream, such as 100 frames at 20 Hz, without expanding that
stream into hundreds of sequential `rtc.send` commands. A stream command owns
frame scheduling inside the browser agent, sends frames against a fixed
wall-clock cadence, and returns one aggregate result with planned, attempted,
completed, failed, dropped, and backpressured frame counts. It also records
send duration percentiles (`p50Ms`, `p95Ms`, `p99Ms`, and `maxMs`), achieved
schedule/completion Hz, pacing drift, jitter, threshold failures, and sampled
frame observations. Typed RTC sends and frames wait for admission within the earlier
command timeout or absolute deadline; an otherwise unbounded send uses a 5,000 ms
admission budget. Message TTL remains independent. Frame observations report
`queued` from lifecycle state, `enqueued` from durable admission, and
`backpressured` for rate-limited or circuit-open admission, never for no-route: the
stream's backpressure count counts those admission refusals, not channel backpressure.
`queued` and `enqueued` are absent when a frame has no decoded typed-message send result.

`rtc.stream` differs from `loop` plus `rtc.send`: `loop` intentionally awaits
each child command and is best for deterministic command-rate workflows,
retries, and evidence trees. `rtc.stream` schedules frames without waiting for
the previous frame to finish before scheduling the next one, so it is the right
shape for realtime performance baselines. Keep using plain `rtc.send` for
single-message smoke tests, provider parity checks, NACK diagnostics, and flows
where each send should be a distinct command result.

Stream payloads support stream placeholders after normal config/session
placeholders are resolved: `{stream.index}`, `{stream.iteration}`,
`{stream.elapsedMs}`, `{stream.scheduledElapsedMs}`, and
`{stream.commandId}`. Recipes must provide `count` or `durationMs`, and
`intervalMs` or `rateHz`. `maxInFlight` bounds memory and backpressure; frames
above the in-flight limit are recorded as dropped instead of creating unbounded
promises. `rtc.stream.thresholds` can fail the command when delivery,
backpressure, latency, drift, or jitter misses configured limits.

Composite conformance coverage lives in `composite-conformance.ts`. It defines
the representative `loop`, `parallel`, `wait`, `assert`, cancellation, and
negative delivery recipes plus provider rows for deterministic local,
browser-rallar, and remote-browser/control-server execution. The companion
report shape compares expected recipe behavior with observed command results,
diagnostics, redacted failures, provider capability differences, and compact
composite summaries.

`wait` is a browser-agent evidence primitive. It observes current and future
runtime events, messages, diagnostics, stats, reports, and results without
reimplementing Rallar behavior. Match fields are intentionally simple: event
kind, topic, command ID, connection, transport, severity, and payload-path
`equals`, `contains`, or `exists`. Wait results include the matched event after
the standard redaction pipeline. If neither `timeoutMs` nor `deadlineEpochMs`
is supplied, the runtime uses a 5 second default timeout.

Cancellation and deadlines are part of the runtime contract. `recipe.cancel`
requests cancellation through the active runtime abort signal, so waits, loop
interval sleeps, browser HTTP requests, WebSocket open waits, and browser
Rallar RTC/WS calls can stop before their ordinary timeout when supported by
the host API. Failed, cancelled, or timed-out `recipe.run` execution invokes
the optional runtime cleanup hook; the browser adapter uses that hook to close
owned WebSockets, detach listeners, and close the browser Rallar runtime.

Direct duplicate commands still use `commandId` replay for idempotent retries.
Child commands inside a new `recipe.run` are executed with cache bypass, so a
second recipe run with the same child `commandId` values does not inherit stale
results, messages, sockets, or RTC state from a failed or cancelled prior run.

WS/RTC runtime diagnostics should use
`toRallarBlackBoxRuntimeDiagnostic(...)` before they are recorded as
`kind: "diagnostic"` evidence. The payloads always expose
`diagnosticSchemaVersion`, `diagnosticTypeId`, `topic`, `severity`, `message` and
the producing `source`, plus the `transport`, connection/group/peer identifiers
and structured `data`/`error` details a diagnostic concerns. `wait` can match these diagnostics by event fields and payload paths,
and `assert` can read them through `diagnostics` or `recentDiagnostics`.

`assert` is a small browser-agent evidence check. It reads only whitelisted
runtime sources: `state`, `config`, `currentConfig`, `lastResult`, `events`,
`messages`, `diagnostics`, `reports`, `recentEvents`, `recentMessages`,
`recentDiagnostics`, `latestStats`, `stats`, `failures`, and `resultCache`.
Supported operators are the full set documented under "Assert Operators"
above, from the historical `equals` / `notEquals` / `contains` / `exists` /
`gte` / `lte` through the extended `gt` / `lt` / `between` / `length` /
`matches` / `matchesShape` / `matchesShapeComplete`. It is not a JavaScript
evaluator; source strings are dot paths into those read-only roots. Assertion
values and errors pass through normal redaction.

Distributed-run manifests can opt into a control-server barrier:
`"barrier": { "enabled": true, "timeoutMs": 5000 }`. The barrier is not a new
browser-agent command kind; the control server queues ordinary `health`
commands linked with the distributed `barrier` phase and treats their successful
results as `barrier.ready` evidence before auto or scheduled starts proceed.

## Ownership

`rallar-bb-test` owns browser-agent command and recipe schemas.

`black-box-runner` owns scenario schemas for external runner recipes.

`apps/rallar-black-box` should consume these schemas for JSON editors,
preflight validation, catalog badges, and distributed-run authoring. The SPA
should not keep separate command-shape validators except for UI-specific checks.

`apps/rallar-black-box-control-server` should expose the shared command schema
in OpenAPI and validate inbound command payloads before queueing.
