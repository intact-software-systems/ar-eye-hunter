# Game design

Status: proposed rules for playtesting. Numerical values are starting hypotheses.
This document owns gameplay; [architecture](architecture.md) owns how it is enforced.

## Fantasy and player verbs

You are an overconfident little thief in a bustling toy market. Wind-up security
guards pursue noisy bags of stolen tokens. Your friends are rivals, but their
chases create opportunities for you.

**Move, collect, dash, bank.** These four verbs must support a satisfying round
before introducing another ability or mission. Character appearance has no effect
on speed, collision size, cooldowns, or earnings.

An example moment: you have a valuable bag and the bank is close. A jackpot opens
across the square. Your friend leads a guard past its entrance. You can bank safely,
dash behind the guard toward the jackpot, or take the longer route while they fight
for it. The game produces a story through visible choices.

## Core loop

1. Enter a private room through a shared link or code; choose a cosmetic and ready.
2. See a short countdown and a playable instruction: “Collect. Bank. Don't get caught.”
3. Collect loose tokens automatically by moving over them.
4. A bigger carried bag raises its potential deposit bonus and your guard attention.
5. Reach either bank and hold Bank to deposit; leave with an empty bag and lower heat.
6. If caught, lose the carried bag, watch a short readable setback, and respawn.
7. At the round deadline, only accepted banked points count. Compare results and ready again.

No permanent elimination. No mandatory waiting for other players after every raid.
No passive survival income. Banking is available from the first second.

## First complete ruleset

| Rule                 | Initial proposal                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Room                 | 2–6 human players; prove four before qualifying six                                      |
| Round                | 180 seconds plus a 3-second shared countdown                                             |
| Movement             | Same normalized maximum speed on all input devices; no sprint button                     |
| Dash                 | 0.2-second burst; 4-second cooldown; follows current or last nonzero movement            |
| Dash collision       | Stops at walls; no invulnerability; cannot pass through a guard                          |
| Pickup               | Automatic, server-confirmed; no precision tapping or aiming                              |
| Bag                  | Capacity 30 base-value units; ordinary token worth 1                                     |
| Deposit              | Hold Bank for 0.9 seconds inside a booth's marked zone, while stationary                 |
| Deposit cancellation | Movement, dash, released input, catch, lost input freshness, or match end                |
| Payout               | Base bag value plus floor(value × bonus); 0% at 1–9, 20% at 10–19, 40% at 20–30          |
| Heat                 | Three readable tiers matching those bag thresholds; cleared by bank/catch                |
| Catch                | Bag becomes zero; floor(half its base value) drops as bounded loot; remainder disappears |
| Respawn              | 3 seconds after catch at a safe pad; 1-second shield forbids pickup and banking          |
| End                  | Unbanked loot expires; greatest banked score wins; ties are shared                       |

A jackpot bundle contributes 5 base-value units. A pickup that cannot fit in the
remaining bag capacity stays on the ground; do not partially consume it. Deposits
move the whole bag into banked score atomically. There are no fractional points.

The deposit bonus creates a reason to stay out, but the risk comes from guard
attention rather than slowing a touch player's movement. Tune bonus and heat together.
Do not add a hidden bonus for the trailing player or punish the leader through an
invisible rule.

## Guards and social interaction

Start with one guard archetype and two guards on the four-player map. A guard
patrols a visible route, notices a runner within its line of sight, telegraphs
recognition for 0.6 seconds, then chases. Obstacles break sight. After 1.5 seconds
without sight it investigates the last seen position and returns to patrol.

Heat expands detection range within the fixed camera view. It does not grant
knowledge through walls. Guards use a visible target marker and do not switch
targets on every frame: a target must be lost or caught before ordinary retargeting.
Initial map tuning must give a fresh player a viable route away from every bank.

Players pass through one another; no body-blocking, attack button, or direct stun.
They compete for routes and loot. A runner can draw a guard toward a rival's route,
then break sight behind a stall. A guard can catch only its current pursuit target;
contact with other runners is harmless and does not push them. After losing that
target it may notice a rival, but the rival receives the full recognition telegraph
before becoming catchable. A guarding or investigating guard cannot catch by
incidental contact. This creates bait-and-escape opportunities without instant
third-party hits, a combat system, or unavoidable spawn camping.

Catch contact is a simple swept-circle test in the game rules. Art, shadows, and
bag size never change the hitbox. No lag-compensated rewind of catches in the first
release: readable anticipation, modest speed, and measured correction behavior
must make the server decision tolerable.

## Arena and public event

Ship one authored, top-down market: two bank booths on opposite sides, a central
jackpot stall, an outer safe-but-long route, two cross-market shortcuts, and stalls
that break sight. Corners are rounded and passages are generous. Every valuable
area has at least two exits. Avoid long dead ends, tiny doors, and decorative
walls that disagree with collision.

Starting spatial hypothesis: a 24 × 24 world-unit arena, a 12 × 12 local view,
runner diameter 0.9 units, ordinary speed 3 units/second, and passages at least
2.5 runner diameters wide. A dash must help navigation without crossing a whole view.
Freeze map geometry and these values in a versioned round configuration.

Ordinary pickups have authored slots and a 12-second respawn delay. No ordinary
pickup slot is inside a bank zone or respawn pad. Keep a total entity cap and
never spawn under a runner. Dropped loot expires after 8 seconds
and receives no deposit bonus until it is actually collected and banked.

Every 30 seconds, announce one central jackpot 3 seconds before it opens. It
offers four bundles for 8 seconds, then closes. There is no second mission system.
At 30 seconds remaining, show a final-run warning. Do not silently change movement
or guard rules at the end. Test whether players make an informed final bank run.

## Ordering and fairness

Server ticks determine outcomes. For each running tick: expire stale input, move
runners/guards, resolve catches, resolve uncontested and contested pickups, then
complete eligible deposits. A catch on a deposit's completion tick cancels the
deposit. The interface must not show confirmed banked points before that verdict.

At the deadline tick, finish the round before movement, pickup, or deposit work.
A deposit must complete on an earlier tick. The visible countdown derives from
accepted server time; the warning should leave room for human judgement, not imply
that a tap at zero succeeds.

For contested pickups on the same tick, compare distance at contact; exact ties
use a stable round-seeded order rotated by pickup identity. Never use network
arrival order or permanent account ordering as a hidden advantage. The precise
deterministic comparison belongs in the pure rules and tests.

No display may show extra playable world outside the common camera frame. Desktop
mouse position does not choose a dash direction unavailable on touch. Simultaneous
keyboard axes are normalized to prevent faster diagonals.

## Room and session outcomes

- One active runner per authenticated account per round. A second session observes;
  explicit takeover fences the previous controller and requires fresh neutral input.
- Joining after the countdown starts means spectating until the next round. Do not
  silently add a player to an already balanced match.
- Disconnects do not pause the round or cash out a bag. Apply the exact grace and
  loss policy in [architecture](architecture.md#disconnection-and-recovery).
- A caught player who disconnects can finish the respawn timer but cannot become
  protected indefinitely. All timers are server-owned.
- A voluntary departure forfeits the bag and the runner seat for the round.
  Retain that player's banked score in the final results, marked as left.
- The match continues with one connected runner until its normal deadline. If no
  runner remains connected beyond the reconnect grace, interrupt it with no winner.
- After results, every remaining player explicitly readies for a new round; a
  designated room organizer starts it. Spectators do not block readiness. If the
  organizer leaves, another eligible player can request server-validated start
  after all remaining players are ready; governance privileges do not transfer.

Use existing Rallar room admission and rematch policy where it fits these semantics.
An account's room membership and game participation remain distinct.

## Fun validation and stop conditions

Observe at least three groups of first-time players, including mixed touch and
keyboard groups, over several rounds. Record device and build alongside observations.
Initial targets are learning criteria, not statistical proof:

- At least 4 of 5 observed newcomers collect and bank within 45 seconds without help.
- Caught players regain control within 4 seconds during healthy operation.
- At least two of three groups voluntarily choose a rematch.
- Players can describe a route, bait, escape, or banking decision they enjoyed.
- Touch players can execute the same escape and banking tasks as keyboard players;
  investigate repeated disadvantage before interpreting win rates.

Watch for bank camping, hiding, repeated instant catches, one dominant circuit,
unclear losses, and thumb fatigue. Change map/economy/timing before adding content.
If the core is still dull after two focused tuning rounds, revisit the loop. Do
not use more cosmetics, missions, or a new engine to disguise that finding.

Solo practice can reuse the arena and guards without scoring against other people.
It is onboarding, not proof of multiplayer fun; AI-controlled rival players are
outside the first release.
