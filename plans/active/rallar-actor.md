# RallarActor

This is a product proposal. It is not current product behavior, and it does not
change `docs/product.md`. The pull request is the delivery record. This file
names the product and the outcomes a later implementation would have to meet.
It does not describe how to build them.

## The job

Rallar is a room product. A room has members, presence, validated events, and
live peer updates. Today the member who can use that room directly is a
browser.

Many products already have a host that owns the experience: a game engine, a
simulator, a desktop tool, a venue process. That host needs the room. It
already has a world, a renderer, and its own rules. RallarActor is how that
host becomes a member without becoming a browser and without rebuilding
membership, presence, or peer delivery.

The internet path stays a Rallar room. The host path stays local: the
application and the actor sit on the same machine and talk over a private
attachment.

## Product shape

One actor is one participant. It signs in, enters a room, stays present, sends
and receives, reconnects, and leaves when the host stops. Other members see an
ordinary room member.

The host owns the world, the rules, the rendering, and the product policy. The
actor owns the seat: the session, the membership, the presence, and the group
traffic. A machine that must appear as several people runs several actors, one
per person.

A room may contain any mix of members:

- a browser
- a Unity player
- an Unreal player
- a dedicated simulation
- a companion tool

The room is the group. The engine or application is only the host attached to
one member.

## What crosses the attachment

The host can ask the actor to do the work of a member:

- Start and stop, and report whether the participant is signed in.
- Enter and leave a room, and report who else is present.
- Send and receive reliable room events, such as chat, intents, and other
  facts the room validates.
- Send and receive live updates, such as poses, cursors, and other values the
  room does not store.
- Send match commands and receive published snapshots when the product uses a
  shared match.
- Report a lost seat and a restored seat after a reconnect.

The actor holds that participant's sign-in. The host on the same machine is
allowed to speak as that participant. Members on other machines see only the
room member.

## Which fact travels which way

The actor uses the same planes Rallar already has. The host chooses the plane
by the kind of fact, then the actor carries it.

| The host has                          | The room treats it as        | What the group gets                                    |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| "I am here" and "I entered this room" | Membership and presence      | A scoped seat that survives reconnect                  |
| "This happened"                       | A validated room event       | One ordered fact the whole room can trust              |
| "This is where I am right now"        | A live peer update           | A replaceable stream between members                   |
| "This is the match"                   | A command in, a snapshot out | One shared world, published from the match owner       |
| "We are writing this together"        | An authored document         | A mergeable document                                   |
| "Remember this on this machine"       | A local latest value         | A cache that belongs to this participant               |
| "Here is a generated suggestion"      | A proposal                   | Something the host accepts before it affects the world |

The host keeps simulation and presentation. When a game already interpolates
motion, that smoothing stays in the engine. The actor delivers the updates. It
does not run a second world.

## Unreal and Unity

Both engines attach the same way. A small host kit in the engine starts the
actor, keeps the private attachment, and maps gameplay messages onto
membership, events, live updates, and match snapshots. The kit is packaging.
The product is the actor, so a Unity member and an Unreal member are the same
kind of room member as a browser.

Two postures cover the games that fit Rallar.

**Shared room.** The engine keeps its own world and, when the game needs it,
its own player replication. The actor carries the group around that world:
party, presence, spectators, instructors, companion tools, and cross-engine
observers. A Unity client, an Unreal spectator, and a browser can stand in one
room and see the same membership and the same live updates.

**Carried match.** The match has one world, one score, or one winner. The
match owner publishes snapshots. Every other host renders them. The owner may
be a Rallar match service or a dedicated Unreal or Unity server with its own
actor. Player clients each have an actor, send commands, and render what comes
back. This is the posture for turn-based sessions, cooperative sessions, and
casual realtime sessions.

A dedicated server is one participant: the member whose host publishes the
world. A local couch session that needs two people online is two actors. A
listen server that is also a player is still one participant when it is one
person; the host may both play and publish.

Competitive twitch play and MMO-scale worlds stay with the engine's own
replication and with infrastructure this platform does not provide.
RallarActor can still sit beside that replication and carry the party, the
observers, and the tools. The room product does not replace the movement
system, and it does not add interest management or world sharding.

## Any host that needs a group

The same sidecar fits a non-game process when that process needs a real group
across the internet: named members, admission, presence, trusted events, and
live updates among a room-sized set of participants.

The host is a good fit when it already owns its interface or simulation, and
the group it needs looks like a room:

- A desktop or native companion in a room with browser users.
- A training simulator whose instructor and observers join from browsers.
- A venue, stage, or session process that publishes presence and state to a
  mixed group.
- A multi-site operations or production tool where each site is one
  participant.
- A creative tool that shares presence, live cursors, and an authored document
  with other members.
- A headless session process that must be a member, not only a database
  client.

The test is the room. A product that needs these specific participants, in
this group, with presence and more than one kind of message, is an actor host.
A one-way telemetry feed, or a world with thousands of simultaneous entities,
is a different product.

## Fit

RallarActor does not widen Rallar's limits. It widens who may sit inside them.

| Kind of product                             | Fit through an actor                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Turn-based or asynchronous multiplayer      | Strong. The host sends commands and receives the durable result.                                  |
| Social or collaborative groups              | Strong. Presence, events, and shared documents include native hosts.                              |
| Casual realtime groups                      | Good. Live updates carry avatars, cursors, and other replaceable state.                           |
| One authoritative match                     | The match owner publishes. The actor carries commands and snapshots. Each host renders.           |
| Competitive twitch play or MMO-scale worlds | Outside the room product. The actor may carry the social layer beside the host's own replication. |

## Lifecycle the host can rely on

1. The host starts the actor beside itself.
2. The actor signs the participant in and reports that the seat is ready.
3. The host enters a room. Presence appears for the other members.
4. The host exchanges events and live updates, and match traffic when the
   product has a match.
5. If the network drops, the same participant returns to the same room.
   Membership and durable events catch up. Live updates resume as a fresh
   stream.
6. The host leaves, or the actor stops. The seat disappears for everyone else.

## What this product is among the others

API-v1 remains the room service. The browser runtime remains how a browser
joins. RallarActor is how every other local application joins. Data,
documents, motion, match snapshots, and AI proposals keep their current
meanings. A host uses one only when its product has that kind of fact.

The existing headless browser agent is an operator tool for running recipes.
RallarActor is the participant product those hosts ship with.

## Outcomes, in order

These are customer-visible stages. They are not a build plan.

1. **A shared room.** One actor, one room, presence, one reliable event, and
   one live stream. A Unity host, an Unreal host, and a browser can meet and
   see one another.
2. **A carried match.** One match owner publishes a snapshot. The other hosts
   render it. Commands flow back from player actors.
3. **Host kits.** First-party Unity and Unreal attachments, plus a short
   attachment guide for any other process. All of them use the same actor.
4. **Companion members.** A tool or observer process joins a room that already
   contains players, as its own participant.

## Success

The product is real when all of these are true:

- A Unity player and a browser user share a room, see each other's presence,
  exchange a reliable event, and exchange a live update.
- An Unreal player can take either of those seats.
- One room can hold browser, Unity, and Unreal members together.
- A non-game process can join that same room as its own participant.
- A dedicated host can publish a snapshot that the other members render.
- Stopping a host removes that participant for the rest of the room.
- After a dropped network, the same participant returns to the same room and
  receives current membership and durable events.

## Decisions

- The product is a sidecar participant, one per person, on the same machine as
  the host.
- The host attaches locally. Across the internet, traffic goes through the
  Rallar room.
- Mixed rooms are the normal case.
- The host keeps the world. The actor keeps the seat.
- Scale stays the scale of current Rallar rooms.
- An in-process engine SDK would be a later product, for hosts that cannot run
  a sidecar. It is not part of this one.
