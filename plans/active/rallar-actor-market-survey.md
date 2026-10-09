# RallarActor market survey

Prepared: 2026-10-03. Reviewed against the proposal on 2026-10-09. This survey
accompanies [the RallarActor product proposal](./rallar-actor.md). It is not
current product behavior, and it does not change `docs/product.md`. Prices and
plan names below are the published list offers on the cited pages as read on
that date. Vendors change them.

## Reading of the product proposal

The proposal is internally consistent on the decisions that matter. One actor
is one participant. That participant may hold several groups. The application
owns the world, simulation tick, and interest set. The actor delivers bytes to
the groups and members it is told, with the sender identifiable.

The proposal now distinguishes the simulation tick from network pacing. A host
may schedule every live send itself. For replaceable state it may instead opt
into a paced N-latest-values lane. The actor retains at most the newest N
unsent values and drops the oldest retained value when that bound is full;
N=1 is the ordinary latest-value lane. Cadence, retention depth, and drain
budget remain separate transport policies. The actor still does not simulate,
compute relevancy, or choose a gameplay audience.

One sequencing gap was in the outcomes. A shared group already required a
Unity or Unreal host to meet a browser, while the host kit was a later stage.
The smallest attachment now belongs to the first outcome, and the engine kits
grow with the later delivery controls. The proposal also no longer assumes
that application-paced play requires an in-process actor. A beside-process
attachment is measured first; tail latency, jitter, and missed send windows
decide whether an in-process or lower-copy form is needed.

What the proposal leaves open, on purpose, is a commercial offer.
`docs/product.md` still describes a browser-first platform and places
competitive twitch play and MMO-scale worlds outside the current product. The
actor proposal is a widening of who may sit in a group. It is not yet an
adopted change to that page.

## What was compared

The comparison is the product in the proposal, not a generic multiplayer
stack:

- a local participant that a host starts and instructs
- one participant in one or many groups
- browsers and native hosts in the same group
- the host keeps simulation, relevancy, prediction, and hit judgment
- the network product delivers membership, presence, reliable events, and
  addressed live payloads, with optional bounded N-latest-values pacing

No current product is that exact combination. The nearest products each share
one piece of it.

## Same job, different owner of the world

**Photon Fusion** (Exit Games) is the commercial default for putting a game
engine on a hosted realtime service. The SDK lives in Unity, and Fusion Shared
is in early access for Unreal. Fusion can run shared authority, a client host,
or a dedicated server, and Photon Cloud is the relay. Quantum, beside it, is a
deterministic simulation that sends inputs rather than object state. The
published Fusion meter is concurrent users: a free 100 CCU plan for one
Fusion or Quantum app, then monthly plans at $125 for 500 CCU, $250 for 1,000,
and $500 for 2,000, with a usage plan above that whose minimum is $1,000 per
month. Peak CCU is the sum of regional peaks. Plans from 500 CCU up include
burst rather than a hard disconnect. Photon owns session hosting and, in
Fusion and Quantum, a large part of how game state moves. The game does not
hand Photon an opaque audience and keep the world model entirely outside the
SDK. [1] [2] [3]

**coherence** sells a replication server and a Unity SDK. Unreal is described
as planned, not shipping. The SDK replicates entity state, with rooms and
worlds, client or server authority, and hosted simulators. Its current
development-tools pricing also makes adoption part of the offer: Starter is
free below the published $200,000 revenue-or-funding threshold and Pro is
listed at $1,000 per month or $8,000 per year above it. Cloud hosting still
uses credits, while self-hosting the replication server is a separate license
at 3% of reported quarterly gross revenue. coherence is the opposite ownership
from RallarActor: the product is the replication and interest in networked
entities, and the engine adopts that model. [4] [5] [6] [7] [28]

**Normcore** bills room-hours and bandwidth rather than a peak-CCU cap. The
public tier includes 100 room-hours and 120 GB a month. Pro is $49 a month for
10,000 room-hours and 3 TB, then $0.03 per extra room-hour and $0.10 per extra
gigabyte. The SDK targets Unity-style realtime applications and can include
voice, persistence, and hosting. A room that exists is the billable object,
which is closer to Rallar's group than a per-player license, and the SDK still
sits inside the application as the networking layer. [8]

## A process that joins the room

**LiveKit** is the closest structural shape. An agent is a Python or Node
program that registers with the server and then joins a room as a realtime
participant. The media and data path is WebRTC. LiveKit Cloud meters WebRTC
participant time and, separately, agent session time for agents it is hosting.
The published pricing page includes participant-minute allowances that grow by
plan, and a concurrent-connection cap on the listed plans. The agent is a
sidecar participant. Its usual job is an AI media pipeline, not a game host
handing over opaque world deltas, and the room is a media session rather than
a Rallar group with validated events and scoped membership. The structural
idea is the same: the network product sees another participant, and the
program beside it decides what the bytes mean. [9] [10] [11]

## Room servers with a client in the engine

**Nakama** (Heroic Labs) is an open-source game backend, Apache 2.0, with
client libraries for Unity, Unreal, Godot, and others. It provides accounts,
groups, storage, chat, matchmaking, and authoritative matches. Nakama
Enterprise adds clustering under a commercial license. Heroic Cloud hosts
Nakama on dedicated capacity with usage-based deployment charges and no DAU,
MAU, or CCU cap in the plan description. Hiro, the live-game kit on top, is a
separate per-developer annual license. Satori, the LiveOps product, starts from
$600 a month. The client is linked into the game. Nakama is a backend the game
calls, not a local actor the game instructs. [12] [13] [14] [15]

**Colyseus** is an open-source room server. Rooms are authoritative processes
the application writes. Self-hosting is free. Colyseus Cloud starts at $15 a
month for a provisioned instance, with no CCU, DAU, or MAU cap and no bandwidth
cap; capacity is whatever that instance can run. The client lives in the game.
This is the "you own the simulation, we host the room process" shape. It is not
a sidecar on the player's machine, and a browser and an Unreal build are
together only if both speak Colyseus. [16] [17]

## Engine-native session surfaces

**Unity Multiplayer Services** now centers its Multiplayer Services SDK on a
session abstraction that wraps Lobby, Matchmaker, and Relay and coordinates
player grouping and connection setup. Sessions can sit over Unity Netcode and
relay or dedicated-server arrangements. This is a strong adoption benchmark:
Unity developers get an engine-native package and a coherent session surface.
RallarActor's difference is not that Unity lacks groups. It is that the same
Rallar participant contract can extend beyond Unity to browsers, Unreal,
servers, tools, and agents without taking ownership of Unity's simulation.
[29] [30]

**Unreal Online Services** exposes common engine interfaces for auth, lobbies,
presence, sessions, and other online capabilities, with EOS plugins providing
Epic services behind those interfaces. This is the incumbent integration
experience for an Unreal developer. RallarActor therefore has to be an
idiomatic Unreal product surface, not merely a technically small C++ client.
Its reason to coexist is the wider mixed participant group, not replacement of
Unreal replication or its online-service interfaces. [31] [32]

## Relays and minutes inside a larger platform

**Epic Online Services** includes lobbies, matchmaking, and a P2P interface
with STUN and an Epic-operated relay when a direct path fails. The published
license offers the services without royalty or hosting fees for video games
and related applications, commercial or not. A game studio that only needs
engine-to-engine datagrams can take that relay at no stated network charge.
The SDK is in the game. There is no product obligation to put a browser on the
same membership object. [18] [19]

**PlayFab Party** meters connectivity by player-minute. The published PlayFab
pricing gives a free minute allowance and then about $0.000004 per
player-minute on the first paid band, with voice priced separately and higher,
and Xbox Live use treated as free for those meters. Party is a data and voice
plane inside Microsoft's game backend. The application still integrates the
Party SDK. [20]

**Steam Networking Sockets / Messages** is another constraint on selling bare
transport. Steam's current interfaces provide message-oriented reliable and
unreliable delivery, fragmentation and reassembly, encryption, P2P
connectivity, and access to Steam Datagram Relay. A game that only wants
game-to-game packets already has a mature option in the Steam ecosystem.
Rallar has to earn adoption above that layer through participant identity,
groups, presence, validated events, reconnect, and mixed browser/native
membership. [33] [34]

**Edgegap** and **PlayFab Multiplayer Servers** sell the machine a dedicated
simulation runs on, not the participant seat. Edgegap's on-demand rate is
published at $0.00115 per vCPU-minute, with egress at $0.10 per GB. PlayFab
publishes virtual-machine hours, for example a D2v2 at $0.252 per hour in
several regions, plus egress. A RallarActor on a dedicated Unreal server would
sit beside this kind of host. It does not replace it. Hathora, a similar
orchestrator, has published that game-company service is being shut down after
an acquisition, which is a reminder that "we host your server process" is a
different business from "we carry your groups," and that the hosting business
can disappear while the game still needs a group. [21] [22] [23]

## Groups for applications that are not games

**Ably** and **PubNub** sell presence and fan-out to native and web clients.
Ably's per-minute model charges channel minutes, connection minutes, and
messages; a published rate is $1.00 per million channel minutes and $1.00 per
million connection minutes, with an alternative of $0.05 per monthly active
user. Ably documents that presence delivered to every subscriber grows with
the square of the member count, and points large sets at occupancy counts
instead. PubNub sells monthly active users, with a starter published at $98 a
month for 1,000 MAU and a free band of 200 MAU, and treats channels as
unlimited on the listed plans. These products are the non-game version of a
named group with presence and reliable-enough messages. They do not offer a
lossy peer overlay whose audience is a member list the application recomputes
for live delivery, and the SDK is again in the process, not a local actor.
[24] [25] [26]

## The application already chose the audience

**ROS 2** is not a room service and not a priced consumer product. Its
middleware (DDS implementations such as Fast DDS and Cyclone DDS, and Zenoh
from Kilted Kaiju) discovers peers and delivers on topics with a quality of
service the application selects. The robot graph decides which topics exist.
The middleware does not decide which objects matter. That split is the same
split as the RallarActor proposal: the host names the traffic, the transport
delivers it. ROS 2 has no account, no scoped group admission, and no shared
membership with a browser room. It is the prior art for the servant role, not
a substitute for the group service. [27]

## What the survey implies for the proposal

| Question                                          | What the market already sells                                                                                                                         | What the proposal keeps                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Who computes the simulation and audience?         | Fusion, coherence, and Normcore take a large share inside the SDK. Colyseus and a dedicated server leave it in application code on a hosted process.  | The host application. The actor never simulates or chooses relevancy.                                                             |
| Who owns the network send cadence?                | Engine and networking stacks expose their own send/update policies.                                                                                   | The host may send immediately, or opt into paced N-latest-values transport for replaceable state; N=1 is latest-value.                                           |
| Where does the network code live?                 | Usually in the game process as an SDK. LiveKit also allows a separate program that joins as a participant.                                            | Beside the host by default, with the engine kit as a first-class adoption surface; in-process is a measured optimization.        |
| Can a browser and an engine share one membership? | Only when both sides speak that vendor's client. EOS and Party are game-platform services. Ably and PubNub can, for pub/sub channels.                 | Yes. That mixed group is the normal case.                                                                                         |
| Must the game replace its existing netcode?       | Most game products expect their SDK or engine networking model to carry gameplay.                                                                      | No. Rallar may complement Unreal replication, Unity Netcode, Photon, or another stack.                                           |
| What is the billable object?                      | Peak CCU, CCU-hours, room-hours, participant-minutes, MAU, messages, or a virtual machine.                                                            | Not decided in the product proposal. The business brainstorm takes this up.                                                       |

The empty cell is a local actor, instructed by Unreal, Unity, or any other
process, holding several Rallar groups at once, including groups that also
contain browsers, without taking ownership of the simulation. LiveKit is the
nearest structural shape. Photon, coherence, Unity Multiplayer Services, and
Unreal's own online surfaces set the adoption bar inside game engines. Nakama
and Colyseus are the nearest "your code owns the room" businesses. Epic and
Steam constrain charging for bare datagrams.

That changes the adoption question. The host kit cannot be dismissed as mere
packaging even though the actor owns the network behavior. Time to first mixed
group, engine lifecycle integration, diagnostics, examples, and predictable
failure handling are product requirements. Likewise, a sidecar is not
disqualified by assumed localhost overhead. The product needs measured
end-to-end local latency and p95/p99 jitter, plus evidence about missed
network-send windows; only those measurements justify an in-process path.

## References

1. Photon Fusion pricing. https://www.photonengine.com/fusion/pricing
2. Photon pricing and CCU plans. https://doc.photonengine.com/photon/current/pricing
3. Photon products and SDKs, including Fusion engine support and Quantum. https://doc.photonengine.com/photon/current/photon-products
4. coherence features, including Unity-only SDK and planned Unreal support. https://docs.coherence.io/overview/features
5. coherence multiplayer SDK FAQ, credits and tiers. https://coherence.io/multiplayer-sdk-faqs
6. coherence Cloud hosting rates. https://coherence.io/hosting/cloud
7. coherence self-hosting, 3% of quarterly gross revenue. https://coherence.io/hosting/self-hosting
8. Normcore pricing, room-hours and bandwidth. https://normcore.io/pricing
9. LiveKit Agents, a program that joins a room as a participant. https://docs.livekit.io/agents/
10. LiveKit Cloud pricing, participant minutes and concurrent connections. https://livekit.com/pricing
11. LiveKit billing, agent session minutes versus other meters. https://docs.livekit.io/deploy/admin/billing/
12. Nakama, open source game backend and client libraries. https://heroiclabs.com/nakama/
13. Heroic Cloud pricing. https://heroiclabs.com/pricing/
14. Nakama Enterprise. https://heroiclabs.com/enterprise/
15. Hiro, per-developer license on top of Nakama. https://heroiclabs.com/hiro/
16. Colyseus Cloud pricing. https://colyseus.io/pricing/
17. Colyseus Cloud billing model. https://docs.colyseus.io/cloud/pricing-billing
18. Epic Online Services licensing. https://onlineservices.epicgames.com/licensing
19. Epic Online Services P2P interface, STUN and relay. https://dev.epicgames.com/docs/epic-online-services/multiplayer/nat-p2p-interface/p2p-reference
20. PlayFab pricing, including Party connectivity and voice. https://developer.microsoft.com/en-us/games/products/playfab/pricing/
21. Edgegap hosting rates. https://edgegap.com/resources/pricing
22. PlayFab Multiplayer Servers billing. https://learn.microsoft.com/en-us/xbox/playfab/multiplayer/servers/billing-for-thunderhead
23. Hathora pricing notice of shutdown for game companies. https://www.hathora.ai/pricing
24. Ably pricing models. https://www.ably.com/docs/pricing
25. Ably pub/sub message counting, including presence fan-out. https://ably.com/docs/pub-sub/pricing
26. PubNub pricing, monthly active users. https://www.pubnub.com/pricing/
27. ROS 2 middleware vendors, DDS and Zenoh. Published page: https://docs.ros.org/en/rolling/Concepts/Intermediate/About-Different-Middleware-Vendors.html Source file: https://github.com/ros2/ros2_documentation/blob/rolling/source/Concepts/Intermediate/About-Different-Middleware-Vendors.rst
28. coherence current Development Tools and hosting pricing. https://coherence.io/pricing
29. Unity Multiplayer Services SDK. https://docs.unity.com/en-us/mps-sdk/index
30. Unity Multiplayer Services sessions overview. https://docs.unity.com/en-us/mps-sdk/sessions-overview
31. Unreal Engine Online Services. https://dev.epicgames.com/documentation/unreal-engine/online-services-in-unreal-engine
32. Unreal Engine Online Services EOS plugins. https://dev.epicgames.com/documentation/unreal-engine/enable-and-configure-online-services-eos-in-unreal-engine
33. Steamworks ISteamNetworkingSockets. https://partner.steamgames.com/doc/api/ISteamNetworkingSockets
34. Steamworks ISteamNetworkingMessages. https://partner.steamgames.com/doc/api/ISteamNetworkingMessages
