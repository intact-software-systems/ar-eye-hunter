# Grumpy Town game design

Status: evolving gameplay direction. See [the local trial](babylon-local-trial.md)
for implemented behavior and [the development sequence](development-sequence.md)
for the next two slices. Numeric timings, scoring and final win conditions remain
playtest hypotheses. This design supersedes cash/banking as the assumed core loop;
banking is now optional future content, not a prerequisite for proving the fun.

## Fantasy and purpose

Mischievous kids keep a town of permanently grumpy people busy putting things
back in order. Making a mess buys a window to get elsewhere and cause fresh
trouble. When businesses are tidy, owners watch the streets. Witnessed mischief
can trigger pursuit, zaps and eventually a short authority raid.

The audience is ages 6–14. Use expressive cutout faces, deadpan anger, fart jokes,
water, slippery fruit, absurd clothes and cartoon mess. Setbacks should be funny
for the victim too. Keep causes visible, allow counterplay and avoid repeatedly
removing control. Ordinary play never eliminates a child from the round.

## Controls and core loop

Move with the floating joystick or keyboard. One **DASH + DROP** action bursts
in the current or last movement direction and uses the loaded prank. Pickups
load automatically; no aiming stick or inventory menu is needed. The current
playground uses a 0.2-second dash and 3-second cooldown.

1. Read who is cleaning, watching or chasing, and choose a route.
2. Cause fresh trouble: spill fruit, redirect water or release a cart.
3. Use the resulting distraction to move on; another tidy owner may witness it.
4. Evade ordinary pursuit, or react to a clearly announced local authority raid.
5. Rescue frozen friends or escape, recover from short setbacks and keep playing.
6. Finish a short timed round with all qualifying winners and optional funny awards.

## Owner duties and escalation

| State | Behavior | Player opportunity |
| --- | --- | --- |
| Cleaning/sorting | Prioritizes restoring its own business | A visible temporary window to move or prank elsewhere |
| Watching | Observes a limited, readable area once business is tidy | Avoid its sight or create a distraction |
| Chasing | Pursues a witnessed prank with bounded range/time | Break sight, take another route or dodge a warned zap |
| Calling authorities | Visibly raises an alarm for a few seconds | Interrupt in time or prepare to leave the affected district |

An owner must witness an actual prank, not merely dislike the player's presence.
Mess at its own business takes cleanup priority; another owner can witness the
same prank and pursue. Show progress as the cleanup nears completion. The current
playground instead zaps before cleanup; that sequence must change in the next slice.

Fresh interactions should matter more than repeatedly striking one stall.
Limit repeat scoring and prevent permanent distraction locks. A chasing owner
should not instantly abandon pursuit for every fart. NPC personality can later
vary patience or cleaning speed, but establish one understandable policy first.

## Authority raids, freezing and rescue

The user's proposal is a bounded authority swarm. Start with a few readable
agents in one district: announce their entrance and roughly 20-second presence,
then have them leave and enforce a quiet cooldown. Crowds everywhere at once
would remove the route choices the town is meant to provide.

A catch freezes the player into a funny statue. Friends thaw them with about one
second of nearby dwell; automatic release prevents abandonment. Test a six-second
starting duration against the user's roughly ten-second suggestion. Display the
countdown; let frozen players wiggle or signal for help. Catchers move on, and
newly freed players get a short immunity window to escape.

Ordinary owner zaps can cost a small number of points; authority catches impose
the temporary freeze. Avoid piling a large score loss onto a long freeze or
instant recapture. Rescue rewards must not make repeated capture/rescue farming
more profitable than playing. No additional rescue button is planned.

## Scores, friends and multiple winners

**Confirmed requirement:** timed rounds can have several winners.

**Recommended hypothesis:** personal mischief scores with shared survival during
raids. Pranks earn most points; rescues give a modest bonus/escape benefit.
Reaching a visible personal target qualifies a player without ending their play.
Propose keeping earned qualification once reached; exact score-loss and target
rules still need confirmation. Start round-length testing around two minutes.

The user has not chosen between this, a fully cooperative score or competitive
optional rescue. The hybrid is recommended because it permits rivalry and rescue
without making abandoning a friend the obvious winning strategy. Judge this in
real multiplayer, not from a local stand-in.

Allow accidental chaotic encounters, but do not make deliberately trapping friends
or repeated helplessness an optimal strategy. Optional awards such as biggest
troublemaker and most helpful friend can celebrate different roles. An interrupted
round must not fabricate winners.

## A varied town square

The current six stalls repeat the same spill/cleanup pattern. The requested town
needs different causal interactions and cleanup jobs, not merely more copies.

| Place | Dash/contact interaction | Tactical change | Owner's cleanup |
| --- | --- | --- | --- |
| Fruit stall | Tip the display | Rolling fruit creates slippery routes | Gather scattered pieces, then restock |
| Central fountain | Knock a nozzle sideways | A telegraphed sweeping jet soaks people and nudges loose objects | Reach and repair the source |
| Parcel cart | Release the brake | A bounded rolling route sheds parcels and briefly obstructs a street | Stop/retrieve cart, collect parcels |
| Laundry line | Dash through hanging clothes | Scattered washing and absurd temporary headwear | Retrieve washing and rehang it |
| Powder counter | Burst a sack/use pickup | Local dizziness and cartoon puke alter route choice | Clear spilled stock and recover |
| Street toilet | Trigger a conspicuous overflowing flush | A substantial, announced mess changes a local route | Stop overflow, then mop |

These are candidates, not all committed implementation. First prove **fruit,
fountain and parcel cart**: slippery ground, a changing hazard and a moving
obstruction. Keep each source interruptible or bounded; do not simulate unlimited
fluid or physics chains. Funny clothing can initially be cosmetic so it does not
obscure vital warnings or controls.

Put the fountain at the central landmark, businesses around the perimeter, two
broad crossing routes and side alleys. Every valuable area needs two exits.
Interactivity should create routes and encounters without filling every gap with
colliders. Exact prop positions and sightlines require an authored map pass.

## Camera, readability and fairness

Use a connected scrolling and zoomable town with natural borders. Larger must
still mean frequent interesting encounters. The current local walkable region is
48 × 48 world units; size alone does not establish a good layout. Protect space
above thumbs, readable expressions, warning targets and escape routes.

[Mobile and controls](mobile-and-controls.md) owns responsive layout and zoom.
Essential cues use shapes/poses and timers as well as color and sound. Avoid
unannounced offscreen catches. Players initially pass through one another;
competitive body-blocking is not assumed.

## Rallar authority and interruptions

One appointed browser runs pure fixed-step rules through Rallar-only multiplayer.
Clients submit inputs, never positions, points, captures or victory claims.
Owner duties, prop state, alarm/raid timers, frozen/release state, rescue progress,
invulnerability and accepted scores all belong to host state and checkpoints.
Rendering cannot decide an outcome. See [architecture](architecture.md).

A local companion may demonstrate rescue before networking, but must be clearly
identified as a stand-in. No local demo proves social fun or host recovery.
Rallar appointment, stale input, checkpoint and interruption requirements remain
unchanged by the new gameplay. On authority loss, pause/recover truthfully or
interrupt the round; never let a frozen player's timer silently continue on one
client while the host has stopped.

## Fun acceptance

Observe small mixed-age groups using phones, tablets and keyboards:

- Do they understand how mess buys time and change routes as cleanup finishes?
- Do different props invite different plans instead of repeated button presses?
- Can they explain why an owner chased or authorities arrived?
- Are chases escapable and freezes funny rather than frustrating?
- Do they voluntarily rescue friends, laugh about what caused the raid and rematch?
- Can younger players contribute without an older player directing every move?

If these signals are absent, tune the duties, route choices and recovery costs.
More props or another renderer cannot substitute for an enjoyable core loop.
