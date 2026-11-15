# Game design

Status: selected direction with proposed rules for playtesting. Numerical values
and the precise win condition are tuning hypotheses, not implemented behavior.

## Fantasy and purpose

Overconfident troublemakers turn a scruffy market into a slapstick chase.
You dash away leaving a fart distraction, a friend slides through a puddle onto
ice, and a furious guard tumbles after them. Cash supplies route objectives;
outsmarting friends and reacting to readable chaos supplies the fun.

The audience is ages 6–14. Use deadpan expressions, bodily-function jokes and
absurd falls. Short setbacks should amuse the victim too. Keep clear counterplay,
avoid repeated helplessness, and keep everyone playing after mistakes.

## Controls and core loop

Move with a joystick or keyboard. One **DASH + DROP** action bursts in the current
or last movement direction and leaves a distraction at the departure point.
It uses one cooldown, so spending it on a prank also spends an escape opportunity.
No aiming stick or inventory selection is required in the first trial.

Pick up cash automatically. Standing still in a marked bank zone starts a short
visible deposit; moving or dashing cancels it. This automatic banking is a proposal
that removes the separate Bank button. The appointed host confirms all outcomes.

1. Join a private Rallar room, choose an identity and ready.
2. Collect cash while avoiding guards and reacting to friends' pranks.
3. Choose a safe bank route or risk another pickup.
4. Slip, recover, retaliate and keep playing.
5. Finish the timed round, see all winners, and choose a rematch.

## Small first ruleset

| Rule | Proposed starting behavior |
| --- | --- |
| Players | Prove two first, then four; six only after host/device qualification |
| Round | 180 seconds with a short shared countdown |
| Movement | Normalized speed across touch and keyboard; no faster diagonals |
| Dash-and-drop | 0.2-second burst, 4-second cooldown, stops at solids |
| Drop | One noisy fart decoy at dash origin; short visible warning before activation |
| Decoy effect | Nearby investigating/patrolling guards turn toward its sound |
| Pursuit | A guard already chasing must lose line of sight before being distracted |
| Water/ice | Authored hazard patch; reduced steering and bounded sliding duration |
| Slip | Brief recoverable loss of traction, expressive fall; no stun chain |
| Bank | Auto-deposit after 0.9 seconds stationary in the marked zone |
| Cancellation | Movement, dash, catch, stale control connection, recovery pause or round end |
| Catch | Spill some carried cash, brief reset, safe re-entry; banked cash remains |
| Currency | Play tokens only; no real money or purchased gameplay advantage |

In the first moving scene, the puddle/ice is authored and the fart decoy is the
only dropped prank. The mockup shows a possible chain reaction, not a promise of
a water/ice/poop inventory. Add new interacting hazards only after the first
interaction is enjoyable. Cosmetic splats/footprints do not silently change traction.

Guards announce recognition with a readable pose/symbol and give time to escape.
Stalls break sight; all valuable areas have two exits. A distracted guard cannot
instantly catch an uninformed bystander. Players initially pass through each other;
body-blocking and physical player collisions need a separate fun/fairness decision.

## Multiple winners

**Requirement:** timed play can have multiple winners; no forced single champion.

**Recommended rule to test:** every player reaching a visible banked-cash target
before the deadline wins. Zero, one or several players can qualify. Crossing the
target does not eliminate a player or stop the round; earned qualification cannot
be taken away by later slips. The target is versioned round configuration and is
chosen through playtests, not inferred from the mockup's score of 120.

Alternative: highest banked score with shared ties. That technically allows multiple
winners but may produce them rarely. Do not silently substitute this for the
recommended target mode. The exact rule needs user/playtest confirmation before
complete-round implementation. Funny optional awards can celebrate a long slide
or a chain reaction, but are not a second competitive scoring system.

Results must clearly distinguish target winners, non-qualifiers, departed players
and an interrupted round. An interrupted round produces no invented winners.

## Market and camera

One authored, connected scrolling market with loops, open junctions, narrow-but-
forgiving shortcuts and stalls that interrupt sight. Start around two default
phone-view widths across, then tune encounter frequency. Bigger must not mean
wandering alone. Use natural boundaries and cropped scenery, not a square arena
frame. Camera and zoom are owned by [mobile and controls](mobile-and-controls.md).

The overview must let players plan routes; normal play must leave enough space
to see an approaching guard. Do not create unavoidable hits from outside the
view. Hazard visibility, guard warning distance and zoom limits are tuned together.
Public jackpots, bag heat and payout bonuses are deferred until the basic prank
loop earns them.

## Ordering and fairness

The appointed browser runs the same pure fixed-step rules for everyone, including
its own player. Clients submit input, never positions, money or victory claims.
Each tick expires stale input, advances movement and hazards, resolves catches,
pickups and then eligible deposits. A catch cancels a simultaneous deposit.
The deadline is checked before new gameplay outcomes on its terminal tick.

Dash edges have identities and cannot be replayed. Contested pickups use contact
distance and a round-seeded stable tie rule, not packet arrival order.
Confirmed banked cash and results follow the recovery commitment policy in
[architecture](architecture.md); prediction never confirms them.

## Room and interruptions

One runner per authenticated player; explicit session takeover invalidates old
input. Late arrivals observe until rematch. Non-host disconnects expire movement
and use a proposed ten-second seat grace; a live match continues only while a
healthy host and another valid backup remain. Loss of the only backup pauses the
match for up to ten seconds, then interrupts it if no backup returns. Host loss is different: freeze the shared match clock during
recovery, then resume only from a valid checkpoint under a new appointment.
See [recovery](architecture.md#host-loss-and-recovery).

A voluntary departure forfeits carried cash and keeps accepted banked cash in
the round record. No remaining connected players means interruption, not a
background simulation or a durable game service.

## Fun acceptance

Observe small mixed-device groups, including younger and older players:
can they cause a prank deliberately, explain a slip, escape a guard and bank?
Watch whether victims laugh and retaliate or feel repeatedly trapped.
Require voluntary rematches, understandable shared wins and comfortable touch use.

If two focused tuning rounds still produce dull chasing or frustrating loss of
control, revise the interaction/map. More props, jokes or another renderer cannot
substitute for that evidence.
