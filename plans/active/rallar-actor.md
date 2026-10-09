# RallarActor

This is a product proposal. It is not current product behavior, and it does not
change `docs/product.md`. The pull request is the delivery record. This file
names the product and the outcomes a later implementation would have to meet.
It does not describe how to build them.

Two companion proposals sit beside this file. The
[market survey](./rallar-actor-market-survey.md) compares related products. The
[business brainstorm](./rallar-actor-business.md) reads the plans this
repository already has and sketches how a RallarActor offer could be sold.
Neither companion changes this product proposal.

## The job

Rallar is a room product. A room has members, presence, validated events, and
live peer updates. Today the member who can use that room directly is a
browser.

Many products already have a host that owns the experience: a game engine, a
simulator, a desktop tool, a venue process. That host needs the room. It
already has a world, a renderer, and its own rules. RallarActor is how that
host becomes a member without becoming a browser and without rebuilding
membership, presence, or peer delivery.

The internet path stays a Rallar group. The host path stays local: the
application and the actor sit on the same machine and talk over a private
attachment.

The actor's capabilities are a product decision. This proposal gives one actor
one participant identity and any number of groups the application asks it to
hold. The broader product thesis is that anything which can run the small host
attachment can become an ordinary participant: a player, server, browser,
tool, observer, bot, agent, or simulator.

## Product shape

One actor is one participant. It signs in, holds the groups the application
names, stays present in those groups, sends and receives, reconnects, and
leaves when the host stops. Other members see an ordinary group member.

The actor can hold one group or several at the same time. The application
chooses each join and each leave. A party and a match, a player standing in
two shards during a boundary cross, and a publishing host present in every
group it serves are the same rule.

The host owns the world, the rules, the rendering, the simulation tick, the
interest set, and the product policy. The actor owns the seat: the session,
membership of the groups it was told to join, presence, and delivery. The host
may also ask the actor to pace a replaceable live stream at a network send
rate and retain only a bounded window of the newest unsent values. That pacing
and retention are transport policy, not a simulation tick: the host still
decides what every payload means and who should receive it. A machine that
must appear as several people runs several actors, one per person.

A group may contain any mix of members:

- a browser
- a Unity player
- an Unreal player
- a dedicated simulation
- a companion tool
- a bot or AI agent

The group is the membership and delivery scope. The engine or application is
the host attached to one member, and that member may sit in several groups.

## What crosses the attachment

The host can ask the actor to do the work of a member:

- Start and stop, and report whether the participant is signed in.
- Join and leave groups, including several at once, and report who else is
  present in each.
- Send and receive reliable group events, such as chat, intents, and other
  facts the group validates.
- Send and receive live updates, such as poses, cursors, and other values the
  group does not store.
- Send a payload to a whole group, or to named members of a group. Members who
  were not named do not receive that payload.
- Send match commands and receive published snapshots when the product uses a
  shared match.
- Send a live payload immediately when the host owns the network send
  schedule. The application chooses the group and member list, and the actor
  delivers the bytes with the sending participant attached.
- Optionally publish replaceable live payloads to a paced N-latest-values
  lane. The application chooses the group and member list. The actor retains at
  most the newest N unsent values; when the bound is full, a newer publication
  replaces the oldest retained one. N=1 is the latest-value lane.
- Report a lost seat and a restored seat after a reconnect, including the
  groups that participant held.

The actor holds that participant's sign-in. The host on the same machine is
allowed to speak as that participant. Members on other machines see only the
group member.

The application owns the simulation tick and the interest set. It decides who
should receive each fact, then tells the actor which groups to hold and which
members of those groups receive the next payload. The receiving application
decides what the bytes mean. The actor does not step a simulation, compute an
area of interest, predict gameplay, replicate an object model, or judge a hit.

Network pacing is optional and does not weaken that boundary. A host may send
every live payload immediately, or it may publish replaceable state faster
than the requested network rate and let the actor retain only a bounded recent
window. A 120 Hz simulation with a 30 Hz live lane is still a 120 Hz host
simulation; Rallar has only scheduled 30 delivery opportunities per second.

### Paced realtime transport

A paced live lane has independent transport policies:

- **Send cadence.** How often the actor may create a network-send opportunity.
- **Retention depth N.** At most the newest N unsent values are worth keeping.
  When another value arrives at the bound, the oldest retained value is
  discarded. The ordinary latest-value lane is exactly N=1.
- **Drain budget.** How many retained values may be sent at one opportunity.
  Retaining N values does not require bursting all N after a delayed tick.

The lane is intentionally lossy. It does not promise that every publication is
delivered, persisted, or acknowledged. Those are different QoS categories.
Its promise is that memory remains bounded and, when publications outrun the
network cadence, recent values displace older obsolete ones according to N.
The host may choose N=1 for state where only the newest value matters, or N>1
when a small amount of recent history is useful for smoothing, interpolation,
or short scheduling disturbances.

## Which fact travels which way

The actor uses the same planes Rallar already has. The host chooses the plane
by the kind of fact, then the actor carries it.

| The host has                           | The room treats it as          | What the group gets                                    |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| "I am here" and "I entered this group" | Membership and presence        | A scoped seat that survives reconnect                  |
| "This happened"                        | A validated group event        | One ordered fact the group can trust                   |
| "This is where I am right now"         | A live peer update             | A replaceable stream between the named members         |
| "Send this live value now"              | A live update to a member list | The named members receive the application's bytes      |
| "Keep my newest N live values moving"   | A paced N-latest-values stream | A bounded recent window is delivered at the requested rate |
| "This is the match"                    | A command in, a snapshot out   | One shared world, published from the match owner       |
| "We are writing this together"         | An authored document           | A mergeable document                                   |
| "Remember this on this machine"        | A local latest value           | A cache that belongs to this participant               |
| "Here is a generated suggestion"       | A proposal                     | Something the host accepts before it affects the world |

The host keeps simulation and presentation. When a game already interpolates
motion, that smoothing stays in the engine. The actor delivers the updates.

## Unreal and Unity

Both engines attach to the same participant contract. A host kit in the engine
starts the actor, keeps the private attachment, and maps application messages
onto membership, events, live updates, and match snapshots. The actor is the
network product, but the Unity and Unreal kits are part of the adoption
surface: installation, engine lifecycle, diagnostics, examples, and a small
idiomatic API determine whether the product is usable. A Unity member and an
Unreal member are still the same kind of group member as a browser.

The kit is not required to replace the engine's existing multiplayer stack.
Unreal replication, Unity Netcode, Photon, or another simulation transport may
continue to carry gameplay while Rallar carries the wider participant group:
party, browser companion, observer, tool, agent, or other mixed member.

Three postures cover the games.

**Shared group.** The engine keeps its own world and, when the game needs it,
its own player replication. The actor carries the group around that world:
party, presence, spectators, instructors, companion tools, agents, and
cross-engine observers. A Unity client, an Unreal spectator, and a browser can
stand in one group and see the same membership and the same live updates.

**Carried match.** The match has one world, one score, or one winner. The
match owner publishes snapshots. Every other host renders them. The owner may
be a Rallar match service or a dedicated Unreal or Unity server with its own
actor. Player clients each have an actor, send commands, and render what comes
back. This is the posture for turn-based sessions, cooperative sessions, and
casual realtime sessions.

**Application-paced play.** The engine runs the simulation tick and the
interest set. It may own every network send itself and hand the actor an
immediate payload, group, and member list. Or, for replaceable state, it may
publish payloads and audiences to an opt-in paced N-latest-values lane whose
network rate is lower than or equal to the application's publication rate. The
actor retains at most the newest N unsent values, with N=1 as the fully
conflating latest-value case. Retention depth and per-send drain budget are
separate from the cadence, so a short scheduling delay need not cause an
unbounded catch-up burst. The actor never chooses the gameplay audience or
interprets the bytes. It returns what other members send with the sender
identifiable.

Competitive twitch play uses one match group and, when the game wants it, a
party group beside it. An MMO-scale world uses many groups: a player actor
holds the few the application currently cares about, and the publishing host
holds every group it simulates. Crossing a boundary is an overlap of two
groups, then a leave, both instructed by the application. Membership changes
are coarser than the simulation tick. The per-send audience is a member list
inside a group.

A dedicated server is one participant: the member whose host publishes the
world. That participant may sit in many groups. A local couch session that
needs two people online is two actors. A listen server that is also a player
is still one participant when it is one person; the host may both play and
publish.

The default attachment may remain beside the host process, including for
application-paced play. The host must not synchronously wait for a sidecar in
its simulation loop; it publishes or sends locally and continues. Whether that
path is fast enough is a measurement question, not a product assumption.
Average attachment latency matters, but p95/p99 jitter and whether scheduling
causes a payload to miss its intended network-send window matter more.

An in-process attachment is an optimization for a host whose measured budget
requires it, not a semantic requirement of application-paced play. A future
lower-copy or shared-memory local attachment may provide another optimization
without changing the participant contract. Sidecar, lower-copy, and in-process
forms must present the same group and delivery semantics.

## Any host that needs a group

The same actor fits a non-game process when that process needs a real group
across the internet: named members, admission, presence, trusted events, and
live updates. The process may use one group or several.

The host is a good fit when it already owns its interface or simulation, and
the group it needs has named participants and more than one kind of message:

- A desktop or native companion in a group with browser users.
- A training simulator whose instructor and observers join from browsers.
- A venue, stage, or session process that publishes presence and state to a
  mixed group.
- A multi-site operations or production tool where each site is one
  participant.
- A creative tool that shares presence, live cursors, and an authored document
  with other members.
- A headless session process that must be a member, not only a database
  client.
- A bot or AI agent that participates in the same group as people and native
  hosts.
- A world of many entities, when the application partitions that world into
  groups and names the audience of each live send.

A one-way telemetry feed with no members is a different product.

## Fit

RallarActor widens who may sit in a group, and it widens a single participant
to every group the application asks that participant to hold.

| Kind of product                             | Fit through an actor                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn-based or asynchronous multiplayer      | Strong. The host sends commands and receives the durable result.                                                                                   |
| Social or collaborative groups              | Strong. Presence, events, and shared documents include native hosts. One participant may hold several groups.                                      |
| Casual realtime groups                      | Good. Live updates carry avatars, cursors, and other replaceable state.                                                                            |
| One authoritative match                     | The match owner publishes. The actor carries commands and snapshots. Each host renders.                                                            |
| Competitive twitch play or MMO-scale worlds | Conditional. The application owns simulation and interest. The actor can carry host-paced or paced live payloads only inside a measured envelope. |

For the conditional case, the product needs a published latency, jitter,
fan-out, throughput, and relay envelope before it can make a genre-level
promise. Compatibility with the abstraction is not yet proof of production
fitness at every scale.

## Lifecycle the host can rely on

1. The host starts the actor beside itself. A measured latency or jitter
   requirement may choose the same contract in-process instead.
2. The actor signs the participant in and reports that the seat is ready.
3. The host joins one or more groups. Presence appears for the other members
   of each group.
4. The host exchanges events and live updates in those groups, including
   payloads addressed to a member list, and match traffic when the product has
   a match.
5. The host joins another group, or leaves one, without dropping the rest.
6. If the network drops, the same participant returns to the same groups.
   Membership and durable events catch up. Live updates resume as a fresh
   stream.
7. The host leaves, or the actor stops. The seat disappears from every group
   it held.

## What this product is among the others

API-v1 remains the group service. The browser runtime remains how a browser
joins. RallarActor is how every other local application joins, including an
application that holds several groups and drives delivery from its own schedule
or opts into paced N-latest-values delivery. Data, documents, motion, match
snapshots, and AI proposals keep their current meanings. A host uses one only
when its product has that kind of fact.

The existing headless browser agent is an operator tool for running recipes.
RallarActor is the participant product those hosts ship with.

## Outcomes, in order

These are customer-visible stages. They are not a build plan.

1. **A shared group.** One actor, one group, presence, one reliable event, and
   one live stream. A Unity host, an Unreal host, and a browser can meet and
   see one another. The smallest host attachment is part of this stage: start
   the actor, join one group, and exchange those two kinds of payload.
2. **Several groups.** The same actor joins a second group and stays in the
   first. Presence, events, and live updates stay inside the group they belong
   to.
3. **A carried match.** One match owner publishes a snapshot. The other hosts
   render it. Commands flow back from player actors.
4. **Application-paced delivery.** The host names a group and a member list
   for each live payload. It can send immediately on its own schedule or opt
   into a paced N-latest-values lane that retains only the newest bounded
   window of unsent values. N=1 is the latest-value case. A
   player actor holds a party group and a match or shard group together. A
   publishing actor sends to different member lists in different groups. A
   boundary cross overlaps two groups, then leaves the old one. The beside-
   process attachment is measured first; an in-process form is required only
   where the measured budget needs it. The Unity and Unreal kits grow to these
   controls here, and a short guide covers any other process.
5. **Companion members.** A tool, observer, bot, or agent process joins a group
   that already contains players, as its own participant.

## Success

The product is real when all of these are true:

- A Unity player and a browser user share a group, see each other's presence,
  exchange a reliable event, and exchange a live update.
- An Unreal player can take either of those seats.
- One group can hold browser, Unity, and Unreal members together.
- A non-game process can join that same group as its own participant.
- A dedicated host can publish a snapshot that the other members render.
- One actor holds two groups at once, and traffic for one stays in that group.
- Stopping a host removes that participant from every group it held.
- After a dropped network, the same participant returns to the same groups and
  receives current membership and durable events.
- An authority host and the other players exchange the application's live
  payloads in one match group, and each payload identifies its sender.
- The host can own every network send, or opt into a paced N-latest-values
  lane without giving the actor ownership of the simulation tick or interest
  set. N=1 behaves as a latest-value lane; N>1 retains a bounded recent window.
- A publishing actor sends live payloads to different member lists in different
  groups. Members who were not named do not receive that payload.
- Crossing a boundary overlaps two groups, then leaves the old one, both on
  the application's instruction.
- The beside-process attachment has a measured latency and jitter envelope,
  including tail latency and missed network-send windows; an in-process
  attachment is introduced only where those measurements justify it.

## Decisions

- The product is one participant on the same machine as the host. The
  capabilities of that participant are set here.
- One actor holds one group or several, as the application instructs.
- The host attaches locally. Across the internet, traffic goes through the
  Rallar groups the actor has joined.
- Mixed groups are the normal case.
- The host keeps the world, simulation tick, and interest set. The actor keeps
  the seat and delivers what it is given to the members it is told.
- Host-paced immediate delivery is always available. Optional paced realtime
  transport may rate-limit replaceable live values and retain at most the
  newest N unsent values. N=1 is the latest-value lane. It does not create or
  own a simulation tick, and it is not a reliable queue.
- Send cadence, N-latest retention depth, and per-opportunity drain budget are
  separate policies; increasing N must not silently change the lane into
  unbounded catch-up delivery.
- The beside-process attachment is the default. In-process or lower-copy
  attachments are performance variants chosen from measurements, not separate
  product semantics.
- RallarActor may complement an existing game networking or replication stack;
  adopting the actor does not require replacing that stack.
