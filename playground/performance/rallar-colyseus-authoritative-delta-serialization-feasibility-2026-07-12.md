# Rallar feasibility: authoritative game loops and binary delta replication

Date: 2026-07-12\
Repository state: `main` at `9540106`\
Scope: static analysis only. No runtime benchmark, packet capture, or product-code
change was performed.

## Executive summary

**Verdict: achievable in Rallar, but not currently available as a Colyseus-like
end-to-end facility.** Rallar already has several of the necessary transport and
game-authority primitives. It does not yet have a shared typed binary state
model, change tracker, baseline/patch protocol, or a general fixed-rate
server-authoritative simulation runtime.

The two scenarios have materially different readiness:

| Scenario                                                  | Feasibility           | Current readiness                      | Main gap                                                                         | Recommended role                                                        |
| --------------------------------------------------------- | --------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Server owns authority, tick, encoding, and WS replication | High                  | Medium-low                             | Binary WS through AL/router plus server game loop and per-client delta baselines | Target architecture for competitive or cheat-sensitive games            |
| Server owns authority and sends directly over WebRTC      | Medium in principle   | Low                                    | Rallar server is not currently a WebRTC DataChannel endpoint                     | Requires a new server RTC peer/gateway runtime; not a codec-only change |
| Browser authority encodes before WebRTC                   | High                  | Medium-high                            | Binary game codec/channel and repair/baseline protocol                           | Fastest credible experiment; suitable for browser-director games        |
| Browser encodes before WebSocket                          | High in principle     | Low through current public Rallar APIs | Browser and server WS facades are JSON-oriented end to end                       | A later transport-surface extension, not the first experiment           |
| Browser encodes only player inputs                        | High, but lower value | Medium for WebRTC; low for WS          | Codec and server decode/validation                                               | Useful only after input bandwidth is measured as significant            |

Top conclusions:

1. **Proven from code:** direct Rallar WebRTC realtime supports binary send and
   receive using `ArrayBuffer`, while its JSON path stringifies separately for
   each target peer. This makes browser-side binary replication possible now at
   the low-level realtime API, and gives it a plausible CPU as well as bandwidth
   advantage for fanout.
2. **Proven from code:** the ordinary Rallar WebSocket and typed-message path is
   JSON-oriented. `ALPayload.resource` is a JSON string, browser and server WS
   facades stringify/parse JSON, topic validation decodes JSON, and server
   fanout sends encoded text. Base64-wrapping binary would work functionally but
   would not be a Colyseus-equivalent binary wire optimization.
3. **Proven from code:** Rallar Game already models authority identity/epoch,
   monotonic sequences, full snapshots, events, sync requests, stale payload
   expiry, keyed replacement, and reliable repair. Those are valuable protocol
   building blocks, but current game snapshots remain ordinary generic objects
   and are sent as full JSON envelopes.
4. **Proven from code:** AR Eye Hunter is browser-director authoritative and
   event/frame driven, not fixed-tick server authoritative. Relic Hunters has a
   server authority, but it processes discrete commands and publishes full
   snapshots rather than running a 30/60 Hz loop.
5. **Proven from scoped static search:** the Rallar server's current WebRTC role
   is signaling, presence, state sync, and topology coordination; the inspected
   server packages do not instantiate a server-side `RTCPeerConnection` or
   `RTCDataChannel`. A server authority can use current WS routing, but direct
   server-to-browser WebRTC would be a separate platform capability.
6. **Strong suspicion:** delta encoding will help most for large, frequently
   updated snapshots with stable object identities. It may lose to compact
   events or full snapshots for small/volatile states, and must be benchmarked
   against Rallar's existing event-plus-periodic-repair pattern.
7. **Proven from code:** Rallar CRDT is already an operation-based logical
   delta system with causal metadata, deduplication, dependency repair,
   snapshots, durable catch-up, and RTC/WS strategies. It can reduce bandwidth
   for concurrent authored documents, but its current wire and persistence
   formats are JSON, and its metadata can exceed a compact authoritative patch
   for small/high-rate game state.
8. **Architectural conclusion:** CRDT and authoritative replication should be
   complementary. Use CRDT for multi-writer authored state that must converge;
   use the authoritative loop for simulation truth. A binary codec can optimize
   both, but the same merge protocol should not be forced onto both domains.

## What “Colyseus-like” means for this analysis

This report separates three concerns that are often bundled together:

1. **Authority and simulation:** one authority consumes player inputs, advances
   state on a deterministic fixed schedule, and is the source of accepted game
   truth.
2. **State replication:** receivers observe an ordered stream of snapshots or
   patches and can recover when a patch is lost, reordered, or based on an
   unknown state.
3. **Wire encoding:** schemas map state to compact typed binary fields and the
   sender transmits only changed fields/collection operations.

Rallar can provide transport and authority without a delta codec, or a binary
codec without server authority. Matching the useful Colyseus pattern requires
all three, plus backpressure and repair behavior.

## Current Rallar capability map

### Authority and game protocol

Rallar has two explicit authority modes: `server` and `browser-director` in
[`packages/shared/rallar-game/types.ts#L3`](../../packages/shared/rallar-game/types.ts#L3).
Authority envelopes carry protocol, kind, room, sender, sequence, timestamp,
authority identity/epoch, and payload
([`types.ts#L28`](../../packages/shared/rallar-game/types.ts#L28)). The shared
sequence tracker rejects duplicate and stale sequences
([`packages/shared/rallar-game/envelopes.ts#L70`](../../packages/shared/rallar-game/envelopes.ts#L70)).

The browser match surface already distinguishes input, intent, event, snapshot,
sync request, presence, and heartbeat traffic
([`packages/shared-web/game/match.ts#L52`](../../packages/shared-web/game/match.ts#L52)).
Only the fresh director can publish a snapshot, and a reliable snapshot can be
sent through the relay while a best-effort snapshot uses a dedicated realtime
lane with a replacement key and a 500 ms maximum age
([`match.ts#L628`](../../packages/shared-web/game/match.ts#L628)). A sync request
can trigger a reliable full snapshot repair
([`match.ts#L690`](../../packages/shared-web/game/match.ts#L690)).

These mechanisms are close to the control plane a delta protocol needs:

- authority epoch protects against an old host continuing to publish;
- sequence numbers reject stale/duplicate envelopes;
- best-effort state traffic can be coalesced;
- sync request plus reliable snapshot provides a repair path;
- separate lanes allow different ordering/retransmission policies.

They do **not** currently say which state revision a patch is based on, whether
the receiver applied it, how schema versions are negotiated, or how a new peer
obtains the baseline.

### WebRTC binary transport

**Proven from code:** direct realtime WebRTC is already binary-capable.

- The public facade exposes `sendBinary` and `onBinary`
  ([`packages/shared-web/browser/rallar-realtime-facade.ts#L15`](../../packages/shared-web/browser/rallar-realtime-facade.ts#L15)).
- Send input accepts an `ArrayBuffer` or `ArrayBufferView`
  ([`packages/shared-web/browser/rallar.ts#L894`](../../packages/shared-web/browser/rallar.ts#L894)).
- `QRtcDataChannel.sendBinary` passes the buffer to the native data channel
  ([`packages/shared/webrtc/QRtcDataChannel.ts#L244`](../../packages/shared/webrtc/QRtcDataChannel.ts#L244)),
  and the raw send path supports binary payloads
  ([`QRtcDataChannel.ts#L671`](../../packages/shared/webrtc/QRtcDataChannel.ts#L671)).
- Inbound non-string messages are routed to binary listeners and normalized to
  an `ArrayBuffer`
  ([`packages/shared-web/browser/rallar.ts#L8138`](../../packages/shared-web/browser/rallar.ts#L8138),
  [`rallar.ts#L8180`](../../packages/shared-web/browser/rallar.ts#L8180)).

The game lane presets already use `binaryType: 'arraybuffer'`. Input and
snapshot lanes are unordered/unreliable and use keyed replacement under
backpressure; intent and replication lanes are ordered
([`packages/shared-web/game/lanes.ts#L24`](../../packages/shared-web/game/lanes.ts#L24)).
The fact that the game currently calls `sendJson` means those lanes transport
strings today; `binaryType` configures received binary representation but does
not itself encode JSON as binary.

### WebRTC fanout and backpressure

**Proven from code:** direct realtime JSON fanout calls `sendJson` for every
peer in a `Promise.all`
([`packages/shared-web/browser/rallar.ts#L4023`](../../packages/shared-web/browser/rallar.ts#L4023)).
`sendJson` performs `JSON.stringify` inside each channel call
([`packages/shared/webrtc/QRtcDataChannel.ts#L237`](../../packages/shared/webrtc/QRtcDataChannel.ts#L237)).
For an unchanged payload this creates at least `O(peer count × payload size)`
serialization work and string allocation. A single pre-encoded immutable
binary patch could be reused for all peers that share the same baseline.

The native data-channel wrapper checks `bufferedAmount`, maintains bounded
queues, supports `replace-by-key`, and expires stale queued items
([`QRtcDataChannel.ts#L251`](../../packages/shared/webrtc/QRtcDataChannel.ts#L251),
[`packages/shared/webrtc/RtcDataChannelSendQueue.ts#L35`](../../packages/shared/webrtc/RtcDataChannelSendQueue.ts#L35)).
This is a good fit for state updates where “latest wins.” It is not an
application-level patch acknowledgement mechanism: a returned `sent` means the
payload was handed to the channel, not that every receiver applied the patch.

### WebSocket and AL payload constraints

**Proven from code:** the current supported WebSocket message stack is JSON
oriented:

- `ALPayload.contentType` only admits `application/json`, and `resource` is a
  string described as JSON
  ([`packages/shared/al-contracts/al-contract.ts#L104`](../../packages/shared/al-contracts/al-contract.ts#L104)).
- AL message construction immediately stringifies the application payload
  ([`al-contract.ts#L179`](../../packages/shared/al-contracts/al-contract.ts#L179)).
- The browser WS client parses every inbound message and stringifies every
  normal outbound message
  ([`packages/shared/websocket/JsonWebSocketClient.ts#L157`](../../packages/shared/websocket/JsonWebSocketClient.ts#L157),
  [`JsonWebSocketClient.ts#L226`](../../packages/shared/websocket/JsonWebSocketClient.ts#L226)).
- The server wrapper can receive a non-string `MessageEvent.data` as `unknown`,
  but its send, pre-encode, and broadcast APIs emit JSON text
  ([`packages/shared/websocket/JsonWebSocketServer.ts#L90`](../../packages/shared/websocket/JsonWebSocketServer.ts#L90),
  [`JsonWebSocketServer.ts#L177`](../../packages/shared/websocket/JsonWebSocketServer.ts#L177)).
- The topic router measures the UTF-8 byte length of the JSON resource and
  decodes it with `JSON.parse` before validation/handlers
  ([`packages/shared-server/rallar-facade/ws-topic-router.ts#L680`](../../packages/shared-server/rallar-facade/ws-topic-router.ts#L680),
  [`ws-topic-router.ts#L770`](../../packages/shared-server/rallar-facade/ws-topic-router.ts#L770)).

Therefore, binary WS is **possible at the native WebSocket level but not an
end-to-end supported Rallar application protocol today**. Encoding bytes as a
base64 JSON string would preserve current APIs but expands the encoded body and
retains JSON/envelope parse/allocation costs; it should be treated as a
compatibility experiment, not the target bandwidth optimization.

### Server-side WebRTC role

**Proven from scoped static search:** WebRTC peer/data-channel construction is
in the shared browser-capable connection service and is consumed by the browser
middleware. The inspected shared-server paths coordinate signaling and compute
RTC topology, for example
[`packages/shared-server/rallar-system/ws-system-topics.ts#L739`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L739)
and
[`packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L164`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L164).
No server-side game DataChannel endpoint was identified.

Consequently, “the server optimizes and sends over WebRTC” is not merely a
serialization option in current Rallar. It would require the server (or a new
gateway/SFU-like data service) to participate as an RTC peer, manage ICE/DTLS/
SCTP lifecycles, expose room authorization to that endpoint, and scale one or
more DataChannels per client. The current server-authority path should be
evaluated over WebSocket first.

### Current game behavior

#### AR Eye Hunter

AR Eye's authority is an elected browser director. The Babylon render loop
invokes `runFrame` before every render
([`apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L830`](../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L830)).
Simulation uses the elapsed frame time rather than a fixed accumulator/tick,
updates local/director state on the render frame, and emits a local pose while
networking is enabled
([`BabylonArena.tsx#L1208`](../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L1208)).
The application limits pose network sends to roughly one per 50 ms (20 Hz)
([`apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1942`](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1942)).

An arena snapshot contains layout, all targets, pickups, players, attacks,
wave, match, events, and active event
([`apps/ar-eye-hunter-v1/src/game/types.ts#L402`](../../apps/ar-eye-hunter-v1/src/game/types.ts#L402));
`toArenaSnapshot` copies those full collections into the snapshot contract
([`apps/ar-eye-hunter-v1/src/game/simulation.ts#L1063`](../../apps/ar-eye-hunter-v1/src/game/simulation.ts#L1063)).
The director publishes full best-effort snapshots after accepted state changes
and throttles reliable repair snapshots to at most one per second
([`useRallarArena.ts#L507`](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L507),
[`useRallarArena.ts#L1305`](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1305)).

AR Eye already reduces replication pressure with compact events such as
accepted hits/pickups and player-state events; it does not continuously
broadcast a full snapshot at render rate. This means a delta codec must be
compared with the current hybrid event plus repair-snapshot design, not with a
naive 60 Hz full-JSON baseline.

#### Relic Hunters

Relic Hunters has a real server authority. Writes are serialized per game,
commands are applied to stored state, and a full public snapshot is published
after each accepted command
([`apps/relic-hunter-server-v1/src/relic-game-service.ts#L44`](../../apps/relic-hunter-server-v1/src/relic-game-service.ts#L44),
[`relic-game-service.ts#L92`](../../apps/relic-hunter-server-v1/src/relic-game-service.ts#L92)).
The snapshot is wrapped in JSON AL and broadcast over WS
([`relic-game-service.ts#L64`](../../apps/relic-hunter-server-v1/src/relic-game-service.ts#L64)).

This is authoritative but turn/command driven, not a fixed 30/60 Hz loop. It is
a good low-rate correctness fixture for a snapshot/patch protocol, but not a
representative stress workload for real-time delta replication.

## How CRDT fits

### Short answer

**CRDT can already reduce logical data transfer by sending operations instead
of whole shared documents. It can also benefit from compact binary encoding.
It is not a replacement for the authoritative game loop.**

The distinction is:

| Property             | Rallar CRDT                                                                            | Authoritative game replication                                                  |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Writers              | Multiple replicas may write concurrently/offline                                       | Clients submit inputs; one authority accepts state transitions                  |
| Ordering model       | Causal/Lamport metadata plus type-specific merge                                       | Authority epoch, simulation tick/state revision, ordered acceptance             |
| Conflict behavior    | Deterministic convergence or surfaced multi-value conflict                             | Authority rejects/resolves conflicting inputs                                   |
| Replicated unit      | Operations grouped in update envelopes                                                 | Events, full snapshots, or base/target patches                                  |
| Lost update behavior | Duplicate-safe; dependency-blocked updates can wait and catch up                       | A chained patch with a missing base cannot apply and needs repair               |
| Best data            | Authored documents, annotations, lists, maps, counters where merge semantics are valid | Physics, positions as truth, health, hits, pickups, timers, scores, match phase |
| Current Rallar wire  | JSON AL messages over WS or RTC                                                        | JSON today; low-level WebRTC binary is available for a new codec                |

The repo guidance explicitly treats Rallar CRDT as collaborative authored
document state, not competitive live-match authority. That boundary remains
correct even if both systems eventually use the same binary transport and
schema infrastructure.

### What Rallar CRDT already provides

The current implementation is no longer only a design proposal. It includes:

- operation types for OR-sets, registers, maps, sequences, counters, and
  min/max numbers
  ([`packages/shared/crdt/crdt-types.ts#L45`](../../packages/shared/crdt/crdt-types.ts#L45));
- operation batches that can group several logical mutations
  ([`crdt-types.ts#L178`](../../packages/shared/crdt/crdt-types.ts#L178));
- update envelopes with document scope, update/replica identity, actor/session,
  Lamport value, parents, schema/operation versions, causal frontier, payload,
  and hash
  ([`crdt-types.ts#L203`](../../packages/shared/crdt/crdt-types.ts#L203));
- duplicate rejection, dependency blocking, and later release when parents or
  observed updates arrive
  ([`packages/shared/crdt/crdt-operations.ts#L430`](../../packages/shared/crdt/crdt-operations.ts#L430));
- snapshots that carry materialized value, included update IDs, clocks,
  tombstone/conflict counts, and a CRDT-state sidecar
  ([`crdt-types.ts#L316`](../../packages/shared/crdt/crdt-types.ts#L316));
- live `ws`, `rtc`, `ws-then-rtc`, and `rtc-with-ws-fallback` strategies
  ([`crdt-types.ts#L487`](../../packages/shared/crdt/crdt-types.ts#L487));
- durable server append sequences, paged catch-up, snapshots, quotas, and
  lifecycle controls
  ([`packages/shared/crdt/crdt-durable-log.ts#L35`](../../packages/shared/crdt/crdt-durable-log.ts#L35),
  [`crdt-durable-log.ts#L161`](../../packages/shared/crdt/crdt-durable-log.ts#L161));
- server validation, authorization hooks, durable append/fanout, and catch-up
  responses over CRDT WS topics
  ([`packages/shared-server/crdt/RallarCrdtServer.ts#L158`](../../packages/shared-server/crdt/RallarCrdtServer.ts#L158),
  [`RallarCrdtServer.ts#L320`](../../packages/shared-server/crdt/RallarCrdtServer.ts#L320));
- browser-local snapshots, pending/failed/dependency-blocked updates, seen IDs,
  and health counters.

This is already a form of **semantic delta replication**: the application emits
the operation it means (`map.set`, `counter.add`, `sequence.insert`, and so on)
instead of diffing and retransmitting the entire materialized JSON document.

### Can CRDT reduce bandwidth?

**Yes, under the right workload; not automatically.**

CRDT is likely to reduce network bytes when:

- a large shared document changes in a few fields/elements at a time;
- operations are batched at a meaningful user-transaction boundary;
- multiple writers would otherwise exchange or overwrite whole documents;
- offline replicas need catch-up by missing operations rather than a full state;
- the update log is compacted and new clients bootstrap from a recent snapshot;
- document paths and identifiers are stable enough for a compact codec or
  dictionary.

CRDT can use more bytes when:

- the underlying value or change is tiny;
- updates are extremely frequent, such as 20/30/60 Hz poses;
- every operation repeats long string paths, document references, UUIDs,
  parents, clocks, actor/session IDs, timestamps, hashes, and observed update
  IDs;
- removals accumulate tombstones or lists of observed update IDs;
- sync requests enumerate a growing `knownUpdateIds` set;
- snapshots include both the materialized value and the CRDT-state sidecar;
- the application emits many single-operation updates instead of batching;
- encrypted envelopes base64-encode nonce/ciphertext/hash fields inside JSON.

The current codec serializes update envelopes with `JSON.stringify`
([`packages/shared/crdt/crdt-codec.ts#L753`](../../packages/shared/crdt/crdt-codec.ts#L753)).
The live transport sends the whole typed update through Rallar messages
([`packages/shared-web/browser/rallar-crdt-transport.ts#L548`](../../packages/shared-web/browser/rallar-crdt-transport.ts#L548)),
which means both the RTC and WS CRDT paths currently use JSON AL envelopes. The
`rtc` strategy does not currently select the low-level binary realtime facade.

Therefore, present-day Rallar CRDT may save bytes compared with full-document
JSON replacement because it sends operations, but it does **not** yet receive
the typed-binary or compact-field benefits described in the Colyseus example.
The size win is a workload hypothesis that needs measurement.

### CRDT versus binary delta patches

CRDT operations and binary state patches are orthogonal layers:

```text
application meaning:  CRDT operation or authoritative state transition
protocol semantics:   causal merge or base/target authority revision
wire representation:  JSON today, compact binary optionally
transport:             WebSocket or WebRTC
```

A binary codec can encode CRDT update envelopes more compactly by using:

- numeric operation and field tags instead of strings;
- schema/path IDs instead of repeated path arrays;
- compact replica/update ID representations;
- varints and fixed-width/quantized numbers where semantics permit;
- update-ID dictionaries for parents and observed sets;
- binary ciphertext rather than base64 JSON strings;
- batch-level shared document, actor, replica, timestamp, and clock metadata.

This can reduce bytes without changing CRDT merge behavior. It would require
versioned encode/decode, bounds validation, canonical hashing rules, and native
binary transport support. In particular, hash compatibility must be defined:
current hashes are derived from canonical JSON
([`packages/shared/crdt/crdt-hash.ts#L8`](../../packages/shared/crdt/crdt-hash.ts#L8)).
A binary wire representation can preserve the canonical logical hash, or define
a new versioned binary canonical form; it must not accidentally make equivalent
updates hash differently across mixed clients.

For a CRDT document, avoid stacking a generic “diff of the materialized CRDT
value” on top of normal CRDT operation exchange. That double protocol loses the
operation identities and causal metadata required for convergence. Binary full
snapshots/keyframes are useful; live incremental traffic should normally remain
CRDT operations encoded compactly.

### Why CRDT should not drive competitive simulation state

CRDT convergence does not mean domain validity or authoritative fairness.

Examples:

- Two clients can each produce a valid `counter.add` operation, but a score
  increase is only valid after the authority accepts a hit.
- `number.min` can converge on health, but it cannot prove damage was legal,
  timed correctly, or applied only once.
- A map can converge on player positions, but it cannot resolve collisions,
  speed hacks, or which pose existed at the authoritative shot tick.
- An OR-set can converge on collected pickups, but it cannot decide which player
  won a simultaneous pickup race under game rules.

Using CRDT for those values would distribute mutation authority to clients and
replace explicit game-rule decisions with merge policies. That conflicts with
the authoritative-loop goal.

Rallar's server CRDT append sequence also does not change this conclusion. It
provides durable admission order and catch-up position
([`packages/shared/crdt/crdt-durable-log.ts#L59`](../../packages/shared/crdt/crdt-durable-log.ts#L59));
it is not a simulation tick, and the server normally persists/fans out an
accepted CRDT update rather than recomputing competitive game truth from input.

### Recommended hybrid data ownership

| Data                                              | Recommended mechanism                                                                             | Reason                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Player input commands                             | Authoritative game protocol                                                                       | Must be authenticated, rate-limited, validated, and applied at a defined tick/state            |
| Physics/world transforms as truth                 | Server or elected-director authority plus state/event replication                                 | Requires one accepted timeline; interpolation remains presentation-only                        |
| Health, hits, pickups, score, timers, match phase | Authoritative state/events                                                                        | Merge policies cannot validate game rules or races                                             |
| High-rate visual pose/presence hints              | Best-effort realtime plus Rallar Motion                                                           | Ephemeral latest-value traffic; neither durable CRDT history nor strict patch chains are ideal |
| Shared room map annotations                       | CRDT                                                                                              | Concurrent additions/edits should converge and survive reconnect/offline work                  |
| Collaborative mission plan/checklist              | CRDT                                                                                              | Multi-writer authored document with semantic operation deltas                                  |
| Shared level/arena authoring before a match       | CRDT, then authority-approved immutable revision                                                  | Collaboration benefits from convergence; gameplay needs a frozen validated config              |
| Player-authored profile/cosmetic draft            | Principal/app CRDT where multi-device merge is desired                                            | Offline/multi-device edits can converge; gameplay effects must still be validated              |
| Lobby-ready state                                 | Usually server-authoritative latest value; CRDT only if merge semantics are explicitly acceptable | Membership and readiness affect orchestration and often need clear server policy               |

A useful bridge is **authoring then acceptance**:

```text
participants edit CRDT document
        -> replicas converge / server log catches up
        -> authority validates a specific document snapshot/hash
        -> authority emits accepted configuration revision
        -> fixed game loop uses immutable accepted configuration
```

Later CRDT edits do not mutate the live match unless the authority explicitly
accepts a new revision at a safe boundary.

### How current CRDT can use the proposed features

#### Server-optimized path

The server can already validate, durably append, sequence, fan out, and page
CRDT updates. It can benefit from:

- native binary WS payloads through the same AL/router extension required by
  server-authoritative state replication;
- encode-once fanout for one accepted immutable CRDT update;
- binary snapshot/catch-up pages;
- compact batch envelopes and update-ID dictionaries;
- slow-client/backpressure handling and byte-level observability.

It should not rewrite accepted operations into state deltas unless acting as an
explicit CRDT compactor/projection. CRDT clients need the operations or a safe
snapshot boundary, not merely the latest materialized JSON value.

#### Browser-optimized path

The browser can encode local CRDT update batches before WebRTC. Rallar already
has low-level WebRTC binary send/receive, but the CRDT transport adapter is
currently typed-message JSON. A binary CRDT lane would need:

- a room-scoped binary channel or explicit peer resolution;
- a CRDT binary envelope discriminator and codec version;
- the same update validation after decode;
- dependency-blocked/catch-up behavior unchanged;
- JSON WS fallback until native binary WS exists;
- careful deduplication when `ws-then-rtc` intentionally sends through both
  transports.

Unlike chained authoritative patches, CRDT updates are naturally duplicate-safe
and often tolerate reordering. However, this implementation explicitly tracks
parents and observed update IDs; missing dependencies are queued and can be
bounded/rejected
([`packages/shared/crdt/crdt-operations.ts#L459`](../../packages/shared/crdt/crdt-operations.ts#L459)).
WebRTC loss therefore still creates catch-up work and possible blocked-state
growth. “CRDT” does not make delivery free.

### Compaction and snapshots

CRDT compaction can reduce **retained log size and reconnect/catch-up bytes** by
replacing a long operation history with a safe snapshot boundary. It does not
directly reduce the size of each new live update.

Rallar's hardening layer requires a snapshot with CRDT-state sidecar, contiguous
append records, and consistent included update IDs before destructive
compaction; encrypted logs require an explicitly authorized supplied state
([`packages/shared/crdt/crdt-hardening.ts#L689`](../../packages/shared/crdt/crdt-hardening.ts#L689)).
Those safeguards are necessary because deleting tombstones/causal history too
early can break convergence.

There is also a bandwidth tradeoff:

- compact too rarely: long catch-up logs and growing observed-ID/tombstone
  metadata;
- compact too often: repeated large snapshots, server/browser CPU, storage I/O,
  and more keyframes sent to new/lagging clients;
- retain too many `includedUpdateIds` in snapshots: snapshot metadata itself
  grows even after materialization is compact.

Snapshot cadence should therefore be selected from measured update count,
bytes, tombstones, conflict count, catch-up latency, and active replica lag—not
only elapsed time.

### Current CRDT performance cautions

These do not prove production bottlenecks, but they matter to the bandwidth
evaluation:

1. **Proven from code:** the browser sends pending CRDT updates one by one during
   `sync()`
   ([`packages/shared-web/browser/rallar-crdt.ts#L822`](../../packages/shared-web/browser/rallar-crdt.ts#L822)).
   The payload supports operation batches, but multiple pending update envelopes
   are not coalesced into one transport frame by this loop.
2. **Proven from code:** after an applied remote update, the browser materializes
   and persists a fresh full snapshot
   ([`rallar-crdt.ts#L1008`](../../packages/shared-web/browser/rallar-crdt.ts#L1008)).
   This is local CPU/storage amplification even when network traffic is a small
   operation.
3. **Proven from code:** live peer catch-up requests include sorted known update
   IDs and cap responses at 100 updates
   ([`rallar-crdt.ts#L1142`](../../packages/shared-web/browser/rallar-crdt.ts#L1142)).
   The request itself can grow with document history.
4. **Proven from code:** current canonical hash and byte accounting serialize
   JSON and allocate UTF-8 bytes
   ([`packages/shared/crdt/crdt-hash.ts#L28`](../../packages/shared/crdt/crdt-hash.ts#L28)).
5. **Strong suspicion:** document materialization can become expensive as
   retained updates and CRDT state grow. `currentModel()` sorts and replays
   updates before materialization
   ([`packages/shared/crdt/crdt-operations.ts#L783`](../../packages/shared/crdt/crdt-operations.ts#L783)).
   Actual impact requires update-count/tombstone benchmarks.

These costs mean “operation is smaller than document” is not enough to claim an
end-to-end win. Measure network, encode/hash, merge/materialize, snapshot write,
storage, memory, and catch-up together.

## Scenario 1: server performs the optimization

### Target flow

```text
browser input -> WS command ingress -> server input queue
              -> fixed simulation tick -> authoritative state revision N
              -> schema change tracker -> patch (base N-1, target N)
              -> per-client/room WS replication -> browser apply
              -> missing base / decode failure -> sync request -> full snapshot
```

### Feasibility verdict

**High feasibility over WebSocket, medium-to-large platform change.** Rallar already supplies
room identity, authorization, authority envelopes, WS routing/fanout, sequence
tracking, snapshot repair concepts, and game-oriented QoS. The missing work is
concentrated in a reusable server game runtime, codec/replicator, and binary WS
transport support.

### What can be reused

- `GroupRef` and room authorization for scoped state ownership.
- Authority reference/epoch to invalidate output from a superseded authority.
- Game envelope kinds and sequence tracking.
- Dedicated input/snapshot/replication concepts and sync requests.
- WS live-only or outbox fanout choices, depending on patch vs repair
  durability.
- Existing full snapshot contracts as the recovery representation during a
  migration.

### Required additions

1. **Server simulation scheduler.** A monotonic-clock fixed-step loop with a
   bounded catch-up policy, input queue, maximum ticks per turn, cancellation,
   room lifecycle, and tick-overrun metrics. A 30/60 Hz configuration is a
   product choice, not a hard-coded platform default.
2. **Shared schema and codec.** Stable field IDs, numeric types/quantization,
   nullable/optional semantics, keyed collection operations, schema version,
   deterministic encode/decode, and bounds validation. TypeScript types alone
   do not provide a stable binary wire schema.
3. **Revision protocol.** Each patch needs at least `schemaVersion`,
   `authorityEpoch`, `baseRevision`, `targetRevision`, message kind, and payload
   length/check. Full snapshots need an explicit revision and the same schema
   version.
4. **Per-recipient baseline state.** The server must know what each client can
   apply. It can either track acknowledged revisions per client, or send room
   patches based on a shared baseline and repair clients that miss it. The
   latter enables encode-once broadcast but creates repair traffic under loss.
5. **Binary WS surface through AL/router.** Binary-aware payload types, size
   checks, topic codec registration, browser receive handling, server send and
   fanout, and compatibility/version negotiation are all needed. Keeping a JSON
   control envelope with a separate binary body is possible, but must avoid
   base64 if wire savings are a goal.
6. **Backpressure policy.** Patches based on skipped revisions cannot simply be
   replaced unless the new patch is generated from the receiver's known base
   or is self-contained. When a queued patch is dropped/replaced, the sender
   must regenerate from the acknowledged base or send a full snapshot.
7. **Observability and lifecycle.** Per-room tick time, queued inputs, encode
   time, patch/full bytes, baseline count, repairs, decode failures, revision
   lag, GC/allocation, and disconnected-client cleanup.
8. **Only if direct server WebRTC is required: a server RTC endpoint.** This is
   a distinct transport project covering peer lifecycle, ICE/TURN, DataChannel
   admission, room routing, backpressure, process distribution, and cleanup.
   The existing browser `sendBinary` API cannot be reused by the server as-is.

### Important server-side design choice

There are two valid replication models:

| Model                                       | Encoding cost                 | Bandwidth behavior                                       | Recovery complexity                                  | Best fit                                               |
| ------------------------------------------- | ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Room-wide patch stream from one shared base | Encode once per tick/room     | Excellent while clients remain synchronized              | Higher; one missed unreliable patch breaks the chain | Ordered/reliable WS, small rooms, predictable delivery |
| Per-client patch from acknowledged base     | Encode/cache by base revision | More server CPU/memory; patch can cover missed revisions | Lower client fragility                               | Lossy RTC, reconnects, heterogeneous client lag        |

For server-to-browser WebSocket replication, ordered/reliable delivery makes a
room-wide patch stream plausible, but application-level gaps still occur on
reconnect or process failover. Full snapshot bootstrap and repair remain
mandatory.

### Authority and security

This scenario delivers the full authoritative property: browsers send inputs,
not accepted state. Binary input is not trusted merely because it is typed; the
server must bounds-check, authenticate the sender, enforce sequence/rate rules,
and validate the command against current state. The current Relic server's
per-game serialization shows the basic race-avoidance shape, but a fixed loop
should enqueue inputs and apply them only at defined tick boundaries.

### Expected performance shape

- Simulation: approximately `O(rooms × ticks × game-step cost)`.
- Change tracking: depends on implementation; mutation tracking can be near
  `O(changes)`, while comparing full immutable trees can approach `O(state)` per
  tick.
- Encoding: `O(changes)` per shared baseline or per distinct recipient base.
- Fanout: unavoidable `O(recipients × patch bytes)` network writes.
- Baseline memory: at least `O(active clients)` metadata; potentially
  `O(active clients × state size)` if implementations retain full per-client
  states rather than revisions/change logs.

No claim that this is cheaper than current Rallar behavior is proven without a
representative benchmark.

## Scenario 2: browser performs the optimization

This scenario has two interpretations, which should not be conflated.

### 2A. Browser director encodes authoritative state for peers

#### Feasibility verdict

**High over WebRTC and the best first experiment.** AR Eye already elects a
browser director, sends full snapshot objects on a dedicated replace-by-key
lane, and has reliable sync repair. The low-level realtime facade already sends
and receives binary buffers.

A game-specific experiment could:

1. keep AR Eye's existing authority and state rules;
2. introduce a binary snapshot/patch codec beside the game contract;
3. use a dedicated binary replication lane via `realtime.sendBinary` and
   `realtime.onBinary`;
4. retain the existing reliable JSON full snapshot for bootstrap/repair during
   the experiment;
5. compare binary delta, binary full snapshot, JSON full snapshot, and current
   event-plus-repair traffic.

This does not initially require changing AL or WebSocket contracts.

#### Main constraints

- The current convenient `rallar.realtime.room<T>()` surface is JSON-only.
  Binary sends are lower level and resolve peers explicitly through
  `sendBinary`; a reusable room-binary channel is absent.
- A browser-director fanout has `O(peer count × bytes)` upload. This is often the
  limiting resource on consumer/mobile networks even after encoding.
- Reusing one encoded patch is safe only if all target peers share its base
  revision. Otherwise the director needs per-base encoding/caching or full
  repair.
- Encoding and change tracking run on the browser main thread unless moved to a
  Worker. AR Eye already performs simulation, rendering, React updates, JSON
  messaging, and audio work there. Main-thread encode cost and GC are therefore
  first-class acceptance metrics.
- Browser authority remains less cheat-resistant and less stable than server
  authority. Binary encoding changes efficiency, not trust.
- Director migration requires the new director to establish a known full state
  and a fresh authority epoch before producing patches. A patch chain must not
  cross authority epochs.

#### WebRTC reliability choice

The current snapshot lane is unordered with `maxRetransmits: 0` and
replace-by-key. That is excellent for self-contained latest snapshots but
dangerous for chained deltas: if patch `N -> N+1` is lost, patch `N+1 -> N+2`
cannot be applied.

Viable options are:

- use an ordered/reliable replication lane for chained deltas;
- send patches from each receiver's last acknowledged base;
- periodically send self-contained keyframes/full snapshots;
- use component updates that are independently versioned and idempotent rather
  than a single strict state chain.

Simply replacing queued delta `N -> N+1` with `N+1 -> N+2` is incorrect for a
receiver still at `N`.

### 2B. Browser encodes before sending over WebSocket

#### Feasibility verdict

**High in principle, low through current public Rallar APIs.** Both directions
of the supported browser/server WS stack assume JSON messages and AL JSON
resources. A real binary path requires the platform additions described in
Scenario 1. Bypassing Rallar with a second raw WebSocket would fragment room
authorization, routing, diagnostics, reconnect, and delivery semantics and is
not recommended as the first architecture.

Base64 inside JSON can prove codec correctness but gives misleading bandwidth
results and retains JSON envelope overhead. It should not be used to decide
whether native binary WS is worthwhile.

### 2C. Every browser encodes its player inputs

This is technically straightforward over existing binary WebRTC. It is not the
same optimization as state delta replication:

- inputs are usually small compared with world snapshots;
- Rallar/AR Eye already rate-limits poses to about 20 Hz and coalesces by player
  key;
- the server/director still must decode and validate every input;
- client-side deltas tied to the client's last sent input can fail across
  drops unless fields are independently reconstructible or periodically reset.

Compact fixed-layout input packets may still be valuable for motion-heavy games,
but input and state-replication benchmarks should be reported separately.

## Findings

| Severity    | Confidence                       | Category                                                        | Location                                                                                                                                                                                                                                                                                                                                   | Why it matters                                                                                                                   | Validation                                                                                                    | Suggested direction                                                                                             |
| ----------- | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| High        | Proven from code                 | Missing end-to-end binary WS                                    | [`ALPayload`](../../packages/shared/al-contracts/al-contract.ts#L104), [`JsonWebSocketClient`](../../packages/shared/websocket/JsonWebSocketClient.ts#L157), [`JsonWebSocketServer`](../../packages/shared/websocket/JsonWebSocketServer.ts#L177), [`ws-topic-router`](../../packages/shared-server/rallar-facade/ws-topic-router.ts#L770) | Server-side binary patches cannot use the normal Rallar WS application path without platform changes.                            | Add a minimal binary echo/topic prototype and verify browser/server/fanout/size/auth behavior.                | Define a versioned binary payload surface rather than base64 JSON.                                              |
| High        | Proven from scoped static search | No server-side RTC DataChannel endpoint                         | Server signaling/topology at [`ws-system-topics.ts`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L739) and [`rallar-rtc-topology-service.ts`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L164)                                                                                  | A server authority cannot currently choose direct WebRTC replication as a drop-in alternative to WS.                             | Build only a lifecycle/capacity spike if server RTC is an actual requirement.                                 | Prefer server WS first; treat server RTC as a separate platform decision.                                       |
| High        | Proven from code                 | Chained deltas conflict with lossy replace-by-key snapshot lane | [`game/lanes.ts`](../../packages/shared-web/game/lanes.ts#L60), [`match.ts`](../../packages/shared-web/game/match.ts#L655)                                                                                                                                                                                                                 | Lost or replaced patch invalidates later patches based on it.                                                                    | Induce loss/reordering and assert revision convergence plus repair count.                                     | Reliable lane, acknowledged bases, or keyframed/idempotent deltas.                                              |
| High        | Proven from code                 | No fixed server loop in inspected game paths                    | [`relic-game-service.ts`](../../apps/relic-hunter-server-v1/src/relic-game-service.ts#L92), [`BabylonArena.tsx`](../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L1208)                                                                                                                                                              | Current authorities are command-driven server or render-driven browser, not fixed-step server simulation.                        | Fixed-step harness with injected inputs and deliberate event-loop stalls.                                     | Add a reusable monotonic fixed-step server runtime only for games that need it.                                 |
| High        | Proven from code                 | Full generic JSON snapshots today                               | [`ArenaSnapshot`](../../apps/ar-eye-hunter-v1/src/game/types.ts#L402), [`publishSnapshot`](../../packages/shared-web/game/match.ts#L628), [`Relic publishSnapshot`](../../apps/relic-hunter-server-v1/src/relic-game-service.ts#L64)                                                                                                       | No field-level change tracking or binary encoding exists in current game replication.                                            | Capture actual snapshot sizes/change ratios across matches.                                                   | Introduce codec beside existing contracts and preserve full snapshot repair.                                    |
| High        | Strong suspicion                 | Browser encode can contend with render/simulation               | [`BabylonArena runFrame`](../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L1208)                                                                                                                                                                                                                                                     | Codec CPU/allocation on the main thread may trade bandwidth for frame-time regressions.                                          | Browser Performance/heap runs with codec on main thread vs Worker.                                            | Worker only if measurement shows main-thread budget is exceeded.                                                |
| Medium-high | Proven from code                 | JSON WebRTC fanout serializes per peer                          | [`sendRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L4023), [`sendJson`](../../packages/shared/webrtc/QRtcDataChannel.ts#L237)                                                                                                                                                                                                | CPU/allocation scales with peer count and payload size.                                                                          | Instrument stringify count/time for 1, 4, 8, and 16 peers.                                                    | Pre-encode immutable binary once per shared baseline.                                                           |
| Medium-high | Proven from code                 | Binary receive may copy some payload forms                      | [`dispatchRealtimeBinary`](../../packages/shared-web/browser/rallar.ts#L8180)                                                                                                                                                                                                                                                              | Normalization can add allocation/GC to a high-rate binary path.                                                                  | Compare `ArrayBuffer`, typed view, and `Blob` allocation profiles.                                            | Prefer `arraybuffer`; consider preserving views only if profiling justifies API change.                         |
| Medium-high | Needs runtime measurement        | Delta may not beat compact events                               | AR Eye event handling at [`useRallarArena.ts#L1305`](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1305)                                                                                                                                                                                                                         | Existing design sends semantic events and periodic repair, so change ratio alone does not establish a win.                       | Measure total bytes/CPU/latency for current hybrid vs alternatives.                                           | Select per traffic class rather than replacing all game messages.                                               |
| Medium-high | Proven from code                 | CRDT wire remains JSON                                          | [`crdt-codec.ts`](../../packages/shared/crdt/crdt-codec.ts#L753), [`rallar-crdt-transport.ts`](../../packages/shared-web/browser/rallar-crdt-transport.ts#L548)                                                                                                                                                                            | Operation deltas avoid whole-document replacement, but repeated JSON field names/IDs and AL envelopes remain on both RTC and WS. | Measure operation-envelope bytes against full document, binary full state, and binary CRDT operation.         | Keep CRDT semantics; add a versioned binary codec only if measured value justifies it.                          |
| Medium-high | Proven from code                 | CRDT metadata can grow                                          | [`RallarCrdtUpdateEnvelope`](../../packages/shared/crdt/crdt-types.ts#L203), [`RallarCrdtSnapshotEnvelope`](../../packages/shared/crdt/crdt-types.ts#L347), live sync request at [`rallar-crdt.ts`](../../packages/shared-web/browser/rallar-crdt.ts#L1142)                                                                                | Parents, clocks, observed IDs, hashes, included IDs, and state sidecars can offset payload savings and increase catch-up bytes.  | Track logical value bytes, operation bytes, metadata bytes, snapshot bytes, and tombstones over document age. | Batch operations, compact safely, and evaluate ID/path dictionaries.                                            |
| Medium-high | Strong suspicion                 | CRDT is unsuitable for competitive match truth                  | Operation kinds at [`crdt-types.ts`](../../packages/shared/crdt/crdt-types.ts#L45), durable append at [`RallarCrdtServer.ts`](../../packages/shared-server/crdt/RallarCrdtServer.ts#L365)                                                                                                                                                  | Convergence does not validate hits, physics, timers, scores, or races; distributing writes weakens authority.                    | Domain fault tests with concurrent/malicious operations demonstrate whether invariants can be violated.       | Keep game truth authoritative; use CRDT only for authored overlays/configuration.                               |
| Medium      | Proven from code                 | Browser snapshot persistence amplifies each applied CRDT update | [`persistAppliedState`](../../packages/shared-web/browser/rallar-crdt.ts#L1008)                                                                                                                                                                                                                                                            | A small network operation can trigger full materialization/hash/snapshot persistence locally.                                    | Profile apply, materialize, hash, IndexedDB time, allocations, and snapshot bytes across document ages.       | Optimize cadence only after profiling; do not infer network savings imply total savings.                        |
| Medium      | Proven from code                 | Pending CRDT sync sends envelopes individually                  | [`rallar-crdt.ts`](../../packages/shared-web/browser/rallar-crdt.ts#L822)                                                                                                                                                                                                                                                                  | Many offline updates incur repeated per-envelope metadata and transport overhead despite batch-capable operation payloads.       | Replay 1/10/100 pending updates and compare frames, bytes, CPU, and catch-up time.                            | Evaluate transport batching or transaction-level operation grouping without changing update identity semantics. |
| Medium      | Proven from code                 | Authority sequence is not a state baseline                      | [`rallar-game/envelopes.ts`](../../packages/shared/rallar-game/envelopes.ts#L70)                                                                                                                                                                                                                                                           | Monotonic delivery rejection does not prove the receiver has the state revision required by a patch.                             | Tests where envelope seq advances but base revision is missing.                                               | Add explicit base/target state revisions.                                                                       |
| Medium      | Proven from code                 | Current health counters do not measure codec effectiveness      | [`RtcDataChannelHealth`](../../packages/shared/webrtc/QRtcDataChannel.ts#L76)                                                                                                                                                                                                                                                              | Buffered amount and dropped/queued counters lack logical/full/patch byte and repair metrics.                                     | Add experiment-local counters before codec selection.                                                         | Standardize metrics only after the experiment stabilizes.                                                       |

## Protocol requirements independent of codec choice

A viable Rallar state replication envelope should include or bind:

```text
protocol id
schema id + schema version/hash
room/group identity
authority kind + id + epoch
message kind: full | patch | ack | sync-request
message sequence
base state revision (patch only)
target state revision
server/director tick or simulation time
payload byte length and optional integrity check
```

Receiver rules:

1. Reject wrong room, schema, authority, epoch, or stale sequence.
2. Apply a patch only when `localRevision === baseRevision`.
3. Validate decoded collection sizes, numeric ranges, IDs, and total bytes before
   materializing untrusted input.
4. Commit `targetRevision` atomically after complete successful application.
5. Request a full snapshot on missing base, unsupported schema, decode failure,
   authority change, or reconnect without a retained valid baseline.
6. Bound sync requests/backoff to avoid repair storms.

Sender rules:

1. Never let a patch chain cross schema or authority epochs.
2. Bound retained change history and per-client baseline metadata.
3. On backpressure, either regenerate from the known receiver base or replace
   with a self-contained full/keyframe state.
4. Periodically keyframe even on reliable transports so corruption, bugs, and
   failover have bounded recovery time.
5. Separate transient events from durable state; not every event belongs in a
   state delta.

## Codec selection criteria

This analysis does not recommend adopting `@colyseus/schema` specifically
without a compatibility spike. The protocol abstraction should first define
Rallar's authority, revision, repair, and transport semantics, then allow a
codec implementation behind it.

Evaluate candidate codecs on:

- browser and Deno/server runtime support;
- deterministic output and stable field identifiers;
- mutation tracking versus full-state comparison cost;
- keyed maps/arrays and entity add/remove operations;
- numeric quantization and string-table support;
- schema evolution and mixed-version behavior;
- zero/low-copy encode/decode paths;
- malformed-input bounds and fuzzability;
- bundle size and tree-shaking;
- licensing/maintenance;
- ability to encode full state and deltas using the same schema.

A hand-written AR Eye codec may win a narrow experiment but creates a long-term
maintenance burden. A generic reflection-heavy codec may save engineering time
while increasing hot-path CPU. Both need measurements.

## False-positive and scope risks

- Full snapshots may be small enough, infrequent enough, or already dominated
  by headers/signaling that a codec has negligible product impact.
- Semantic events may already be closer to the information-theoretic minimum
  than field-level state deltas.
- WebRTC's own transport overhead, TURN relay, packetization, and encryption are
  outside the application payload byte count; smaller payloads do not translate
  one-for-one to total network savings.
- A binary payload can be larger than compact JSON for sparse, string-heavy, or
  poorly designed schemas.
- CPU savings from avoiding JSON may be offset by state diffing, allocation,
  quantization, or per-client patch generation.
- 60 Hz replication is not automatically better than 20/30 Hz state plus
  interpolation. Rallar Motion is already intended for presentation smoothing,
  not simulation authority.
- Browser WebRTC mesh/direct fanout remains upload- and peer-count-sensitive;
  encoding changes constants, not the topology's scaling class.
- Relic's turn-based workload should not be used to predict AR Eye real-time
  results.

## Measurement plan

All temporary artifacts should go under `tmp/perf/` and remain uncommitted.

### Workloads

Use three state fixtures:

| Workload       | Peers | Update rate | State shape                                 | Purpose                                              |
| -------------- | ----: | ----------: | ------------------------------------------- | ---------------------------------------------------- |
| Small          |     2 |    10/20 Hz | 4 players, 16 targets, few events           | Detect fixed codec overhead and regressions          |
| Representative |   4/8 |    20/30 Hz | Captured normal AR Eye match distributions  | Product decision baseline                            |
| Stress         |    16 |       60 Hz | Max bounded entities, churn, reconnect/loss | Capacity and recovery behavior, not a default target |

Also replay real command/event traces for Relic separately at its natural rate.

### Variants

1. Current Rallar hybrid: JSON events plus JSON repair snapshots.
2. JSON full snapshots at selected update rate (control, not proposed design).
3. Pre-serialized JSON fanout once per update.
4. Binary full snapshots.
5. Binary deltas plus periodic full keyframes.
6. Binary deltas with per-client acknowledged bases.
7. Current JSON CRDT operations plus snapshot/catch-up.
8. Binary-encoded CRDT operations with unchanged merge semantics.
9. Whole-document latest-value replacement as the CRDT control.

Run WebRTC and native-binary WebSocket separately; do not count base64 WS as a
binary result.

### Metrics

| Dimension       | Metrics                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network         | logical payload bytes, actual WS frame/DataChannel message bytes where observable, messages/sec, full vs patch ratio, repair bytes, TURN vs direct path                           |
| Sender CPU      | simulation step, change tracking, encode, per-peer/base work, fanout wall time                                                                                                    |
| Receiver CPU    | decode, patch apply, validation, interpolation handoff                                                                                                                            |
| Memory          | allocation rate, peak/retained heap, baseline/change-log bytes, queued payload bytes, GC pauses                                                                                   |
| Correctness     | revision divergence, stale/duplicate rejection, convergence time, decode errors, wrong-authority rejection                                                                        |
| Transport       | buffered amount, queued/replaced/dropped/stale counts, delivery latency percentiles                                                                                               |
| UX              | main-thread long tasks and frame-time percentiles for browser authority                                                                                                           |
| Server capacity | rooms, clients, ticks/sec, tick overruns, event-loop delay, CPU/RSS                                                                                                               |
| CRDT efficiency | operation/value/metadata byte split, updates per user transaction, tombstones, observed/parent IDs, snapshot sidecar bytes, log length, compaction bytes, catch-up pages and time |
| CRDT local cost | merge/materialize/hash time, snapshot persistence bytes/time, IndexedDB writes, blocked-update memory, convergence latency                                                        |

### Falsifiable hypotheses

| Hypothesis                                          | Confirms                                                                                                           | Falsifies                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Pre-encoded binary reduces director fanout CPU      | Encode + fanout CPU grows materially slower than current per-peer stringify as peers increase                      | CPU is equal/worse at representative sizes and peer counts                                  |
| Delta replication reduces network use               | Total bytes including keyframes and repairs are materially below current hybrid traffic                            | Repair/keyframe/metadata overhead erases savings                                            |
| Browser codec fits frame budget                     | No meaningful regression in frame-time percentiles/long tasks                                                      | Encode/diff produces visible or statistically meaningful frame regression                   |
| Loss recovery is bounded                            | All clients converge within the chosen repair SLO under induced loss/reconnect                                     | Clients remain divergent or trigger repair storms                                           |
| Fixed server tick is sustainable                    | Representative room count meets tick deadline with bounded catch-up and event-loop lag                             | Tick overruns or memory grow beyond budget                                                  |
| Native binary WS justifies platform complexity      | Payload/CPU gains remain material after full AL/auth/routing envelope is included                                  | End-to-end improvement is negligible over optimized JSON/events                             |
| CRDT operations reduce shared-document traffic      | Total live plus catch-up bytes are materially below whole-document replacement for representative concurrent edits | Metadata, tombstones, snapshots, and repair equal or exceed replacement traffic             |
| Binary CRDT preserves semantics while reducing cost | Convergence/fault tests remain identical and bytes/CPU improve versus JSON CRDT                                    | Mixed-version/hash issues appear or encode/decode CPU erases the network gain               |
| CRDT compaction bounds catch-up cost                | Log/snapshot storage and new-replica catch-up remain within SLO without lost convergence metadata                  | Snapshot metadata or compaction frequency dominates bytes/CPU, or replicas fail to converge |
| CRDT stays outside live match truth                 | Authoring workloads converge while authority invariants remain solely command/tick controlled                      | Any CRDT path can directly mutate competitive state without authority validation            |

### Correctness and fault tests before performance acceptance

- lost, duplicated, and reordered patches;
- patch received before initial full snapshot;
- reconnect with and without retained baseline;
- director/server authority epoch change mid-chain;
- schema version mismatch and rolling deployment;
- malformed/truncated/oversized binary;
- invalid collection operations and numeric overflow/NaN;
- backpressure replacement while patches are queued;
- server tick stall and bounded catch-up;
- late input, duplicate input, and malicious input rate;
- new peer joining during an active patch stream.
- CRDT duplicate/reordered/concurrent operations across WS and RTC;
- CRDT dependency loss followed by peer and durable catch-up;
- CRDT compaction with late/offline replicas and tombstone-sensitive removes;
- mixed JSON/binary CRDT codec versions with canonical-hash verification;
- authority accepts one CRDT document revision while later authoring continues;
- attempts to use CRDT operations to bypass authoritative game invariants.

## Recommended evaluation order

1. **Measure current traffic first.** Capture AR Eye snapshot/event/input sizes,
   rates, per-peer stringify time, DataChannel counters, and director upload.
   This establishes whether serialization is important relative to render,
   simulation, and topology costs.
2. **Prototype browser-to-browser WebRTC binary replication behind a game-local
   experimental codec.** Preserve reliable JSON full snapshots for bootstrap
   and repair. Compare binary full state before adding delta complexity.
3. **Add revision-aware delta plus fault injection.** Prove convergence under
   loss, reconnect, backpressure, and director migration before comparing peak
   throughput.
4. **Prototype a server fixed-step runner independently of transport.** Replay
   recorded inputs and establish tick/CPU/memory behavior without conflating it
   with codec work.
5. **Only then evaluate native binary WS through Rallar AL/router.** Use the
   measured server-authority workload to decide whether a new public binary
   message surface is justified.

## Final assessment

Rallar has enough primitives to build this cleanly. The shortest path is not to
copy Colyseus wholesale, but to introduce a Rallar replication protocol that
uses existing authority epochs, room scope, sequence tracking, QoS lanes, and
sync repair, with a pluggable binary codec.

For **server authority**, the architecture is strategically sound and best for
competitive truth, but requires a fixed-step server runtime and genuine binary
WebSocket support across the AL stack. Direct server-to-browser WebRTC is not a
current Rallar capability and would be a separate, substantially larger
transport project.

For **browser authority**, WebRTC binary is already technically reachable and
is the strongest first experiment. It can reduce payload size and repeated JSON
serialization, but it preserves browser-host trust and mesh upload limits.
Browser-to-WebSocket binary should wait until the WebRTC experiment proves that
the codec and delta protocol provide material end-to-end value.

For **CRDT shared data**, Rallar already sends semantic operation deltas and has
the causal, snapshot, durable-log, catch-up, and compaction machinery that a
collaborative document needs. That can reduce bandwidth compared with sending
whole documents, especially for sparse edits, but current JSON envelopes and
causal metadata mean no universal saving can be assumed. CRDT can share future
binary codec/transport infrastructure with game replication while retaining a
separate convergence protocol. It should feed the game authority only through
validated, explicitly accepted document revisions—not mutate live competitive
state directly.

No bandwidth, CPU, memory, or latency improvement is claimed as measured by
this report. All expected wins remain hypotheses until the measurement plan is
executed.
