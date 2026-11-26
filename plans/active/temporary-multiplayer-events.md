# Temporary multiplayer rooms and events

A player opens a game in a fresh browser, creates a private room in one tap, and shares it. Friends play and rematch without permanent accounts. Rallar owns temporary identities, authority, admission, recovery and event allocation. Grumpy Town owns its controls and match rules.

## First slice — create and join a private game

1. Start with a browser journey that loses the successful creation response. Retrying from that browser must recover the original room, seated manager and usable invitation. A second browser opening a preview must consume no seat.
2. Provide an app-enabled creation operation with bounded creation, app-configured default and maximum capacity, and an optional creator choice within that range. Four players including the creator is the product default. Persist a fixed expiry and bound empty-room recovery by it. A visit cannot refresh these deadlines.
3. Reuse room-scoped guest identity, admission and reconnect. Keep management scoped to this room. An explicit Join game action takes a seat. Recover the same visit on reload. Opening the invitation on another device starts an independent visit.
4. Exercise four independent browsers through start, join, play and rematch. Exercise a non-default capacity, concurrent last-seat claims on separate API processes, expiry, and lost-response replay. Check the public SDK, bundle, API types and game build.

## Second slice — transfer room management

1. Start with a rejected former-manager command after an accepted handover. Verify the manager, director and seated players through independent reads.
2. Allow the current manager to transfer invitation and moderation rights exclusively to a present player. Authorize and fence the change at commit. A replay after a lost response cannot transfer authority twice. Disconnect alone never grants management.
3. Deliver management changes over the room WebSocket and recover on reconnect. Test handover during play, invite rotation by the recipient, rejection of delayed commands, former manager returning as a player, and a rematch under a replacement director after abrupt loss of the original manager.

## Third outcome — a party enters its assigned court

An authorized organizer opens an event lobby. Players join through an event link with an explicit tap. Each friend consents before the group queues together. They keep previous queue positions until everyone accepts and explicitly resolve any existing offer. The last acceptance sets queue time. A departing member leaves the others in place. Adding a replacement requires fresh consent and a new queue time.

An assignment reserves one court for the whole group. Each player independently accepts via Enter court, retains lobby membership and gains access only to the assigned court. A missed notification is recoverable. The app sets the reservation window, default two minutes. Expiry releases only unclaimed seats. Prove these outcomes across browsers, deadline races and reconnect before generalizing allocation to several courts.

## Fourth outcome — run an event across courts

An organizer creates event-owned temporary courts with individual capacities. The organizer or the current director of that court releases it for its next assignment. Persist that decision so it survives departure or restart. A delayed release from an earlier match cannot release the next one. Allocate to the oldest group that fits while larger waiting groups retain their positions. Shared events default to returning players to the queue. Games own rematch rules.

Event-wide removal immediately revokes lobby and court access and releases queue entries and reservations. Removing and rotating the link also stops new visitors using the old invitation. Existing players retain admission. Event closure closes its courts. Independent private rooms are unaffected. Prove concurrent allocation, worker restart, offline recovery, and two courts turning over independently with the organizer away.

## Engineering boundaries

Use authoritative server mutations, conditional writes, private WebSocket notices and snapshot recovery. Reuse shared product paths and test at their public boundaries. Review changed files and support files in full, remove superseded code, and keep unrelated work outside the change. No migration or parallel compatibility implementation is planned. Expand the detailed implementation horizon after the first two slices supply evidence.
