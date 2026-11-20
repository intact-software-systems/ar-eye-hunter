# Rallar multi-room time and recovery

## Product decision

A player can spend time in room B and return to room A with the correct phase, permissions and cutoff. Opening a preview or learning that another room is ready must preserve the current room until the player explicitly enters. Each room's application authority still owns the meaning of extra time, scores and terminal results.

## Candidate next slice — recover a revised active deadline

Use two scoped rooms and an authorized publisher. In A a host publishes a later deadline against the revision it observed. While a participant is in B, B retains its own independent state. On return to A, reacquire the authoritative revision, use Rallar's bounded clock to derive the phase, and reject stale reads and stale or duplicate edits. Test the return between the old and new cutoffs. Establish whether existing room-scoped state, invalidation and recovery suffice before adding a public SDK API.

Scheduled sessions already cover rescheduling before the lobby opens, reservations, reconfirmation and explicit entry. An edit to an active deadline is a distinct product question. The example poll is an experiment for that distinction. Its ballot and host rules belong to the example.

## Alternative — wait elsewhere for an offer

Qualify the existing scope- and account-bound matchmaking search, confirm, cancel and explicit entry flow while another room is active. Test that the offer survives navigation, stale offers cannot admit a player, and cancellation or expiry releases the claim. Joining a particular existing lobby by code and waiting for an eligible match are distinct operations. Reuse scheduled-session reservations when the player's intent is to reserve a specific future session. Background push delivery is a separate product decision.

## Consumer boundary

Defer the Grumpy Town one-minute action, match checkpoint changes and game HUD. The browser director can own a game's decision to extend, subject to its appointment, but a gameplay-specific action alone does not justify a Rallar API. Stack the game only when it consumes an actual platform dependency. Keep managed pause, host handover policy and effects in empty rooms demand-driven.
