# Grumpy Town interaction and raid trial

The local Babylon playground now tests **make trouble, buy time, escape, rescue**.
It preserves floating movement, one dash-and-drop action and zoom. The orange
**BOT PAL** is a simulated companion; this is not multiplayer or a complete match.

## What is playable

| Interaction | Effect | Cleanup and counterplay |
| --- | --- | --- |
| Fruit stall | Dash tips a stocked display and scatters six slippery pieces | Its owner gathers fruit and restocks; tidy neighbours can chase |
| Fountain | Dash knocks the nozzle into a sweeping jet | Water pushes the player and reduces traction; the apple owner repairs it |
| Parcel cart | Dash releases it along a short route, obstructing the street | The pear owner follows and retrieves it; the cart returns to its starting place |
| Powder pickup | The next dash leaves a cloud; exposed characters get dizzy and briefly puke | Dizziness slows movement without reversing input; cloud and puddle expire |
| Zapper pickup | The next dash shrinks visible owners in front for six seconds | Mini owners move/clean slowly, then recover |
| Bins and old fish | Dash tips rubbish or scatters slippery fish | The assigned owner puts the object back in order |
| Public toilet | Dash overflows cartoon poop and pee | Puddles stain and slip; the owner repairs the toilet |
| Hydrant | Dash releases washing puddles | Water clears stains; the owner repairs it |
| Birds, dogs and cats | Birds drop poop, dogs spray pee, cats spit puke after a fixed warning | Dodge, wash off, or lure a provoked attack into residents/police |
| Fart drop | A witnessed dash attracts attention without needing to damage stock | Escape, break sight, or create a cleanup duty |

Fresh object/stall/fountain/cart trouble and provoked animal collateral award 10 points. Each source has a 30-second
reward cooldown, and hitting an already damaged source gives no additional points.
The fruit owner also maintains the fountain; the pear owner retrieves the cart.
These shared duties create route choices with the existing six NPCs.

The cart follows a bounded scripted path, rather than general physics. It does
not yet scatter parcels. Water affects the player and slows owners/guards; it
does not simulate fluid or push other props. Toilet overflow and temporary brown/yellow/green stains are implemented. Laundry
and clothing transformations remain later candidates.

## Busy owners buy safety

An owner with unfinished duties prioritizes cleanup, showing a broom, complaint
and a shrinking work bar. Once finished, it returns to watching. Harmless walking
does not trigger pursuit. Another tidy owner within sight can witness a dash and
chase even while the affected owner is busy.

Chases last at most eight seconds, end after 1.5 seconds without sight, and use
obstacle-aware routes. Within range an owner marks a fixed target for 0.85 seconds.
Move out to dodge; a hit removes three points, never below zero, and grants two
seconds of protection. Authority catches and owner penalties do not stack on an
already frozen player. Owner zaps no longer miniaturize the player; the player's
zapper pickup still miniaturizes NPCs.

Owners visibly repair the fountain for four seconds or retrieve the stopped cart
for three. A bounded fallback resets unattended fountain/cart trouble after
22/28 seconds; it is a safety limit, not a substitute for working routes.

## Authority raids and rescue

Six fresh rewarded incidents fill **TROUBLE 6/6**, immediately award **+50**, and
start a visible **five-second dispatch warning**. Empty dash spam earns nothing;
repeated hits on unrepaired or recently rewarded objects cannot farm the meter.
The bonus commits the police consequence: further pranks cannot cancel or extend it.

Ten police emerge in staggered departures from the **Ministry of No Fun** at the
north end of town. They pursue for 25 seconds across the square and mark fixed red
targets for 0.9 seconds before firing. Dodge the target, break sight behind a stall,
or lure a creature into them. A hit freezes for six seconds without deducting
points. Frozen/protected characters cannot be caught repeatedly.

At shift end, officers stop attacking and return to the government doorway.
A 16-second return limit and subsequent 12-second cooldown bound the wave. New
messes can still earn ordinary points during the wave, but only the next quiet
phase begins filling a new trouble meter. The former interruptible caller and
three-guard district are removed.

Stand beside a frozen friend for one second, with a clear line between you, to
thaw them. No new button is required. The bot follows and attempts the same rescue
when the player freezes. A countdown and ice cutout make freezing visible; auto-thaw
prevents abandonment. Rescued or auto-thawed characters get 2.5 seconds of protection.
The player earns three points for the first companion rescue in a raid; further
rescues still work but cannot farm that bonus.

Six seconds is a tuning hypothesis against the user's roughly ten-second idea.
Frozen characters cannot yet wiggle or signal. Real friends, timed rounds,
personal qualifying targets and multiple-winner results belong to later work.

## Construction and evidence

The immutable fixed-step simulation owns effects, duties, score, alarm, captures
and rescue. Babylon only displays accepted state. Town rules and presentation live
under `apps/cca-2d/src/town/`; `practice-rules.ts` owns movement and calls the town
coordinator. Obstacle corners form routes with character clearance; the rolling
cart can block route edges. Cutouts, simple meshes and SVG textures keep the build
self-contained, without physics or runtime AI dependencies.

See [actual gameplay and trial limits](babylon-local-trial.md). Browser emulation
and deterministic tests establish local behaviour, not physical Safari performance
or social fun. Keep revisions in the existing draft PR and focus validation on CCA.

## Decisions still to test

Individual mischief scores with cooperation during raids remain the recommended
hypothesis. The user has not selected a final scoring model. Several players may
qualify in a timed match; no elimination is intended.

Watch whether players change routes as owners finish cleaning, deliberately use
the fountain/cart, understand why a raid arrived, and voluntarily rescue a friend.
If they merely spam the action, tune routes/rewards/attention before adding content.
The [development sequence](development-sequence.md) keeps only the next two useful
slices concrete: the living square and phone feedback, then Rallar hosting and recovery.

## Living square rules and approved scope

The user approved adding more action, objects, vomit and poop, grumpy bird-, dog-
and cat-like creatures that can poop or pee on players, and ten police emerging
from a government building after enough mischief. Reaching that milestone awards
a big bonus, with the police response as its price. This is implemented in the current
local scene, preserving the cutout style, movement/dash controls and later
Rallar-only player-host direction.

Implementation tuning: six fresh rewarded incidents fill the trouble meter;
award +50 once and announce dispatch for five seconds. Ten police visibly leave
the government doorway in a staggered group and pursue for 25 seconds, then
return without attacking. A quiet cooldown prevents overlapping waves. The
bonus cannot be kept while cancelling its police consequence. This replaces the
old three-witnessed-dashes/interruptible-call mechanism. Harmless movement and
empty dash spam do not advance the meter. Repeated hits on unrepaired or recently
rewarded objects cannot farm it.

The square contains two birds, two dogs and two cats. Birds telegraph droppings; dogs chase and
telegraph pee sprays; cats patrol their territory and cough up puke. They dislike
players, pursue within limits, lock their attack aim before firing, and recover
between attacks. Players can lure a provoked attack into residents and police.
Unprovoked animal accidents earn no player bonus or trouble. A newly soiled
resident stops to clean; soiled police are briefly distracted. Players get
visible temporary stains and slippery patches rather than another long stun.
Stains last six seconds; seven-second mess immunity prevents continuous reapplication.
Water washes stains off and gives two seconds of washing protection. Ground mess
lasts ten seconds for animal attacks or fourteen seconds for object spills.
Existing freeze/rescue protection remains intact.

There are two tipping bins, a fish display, a public toilet and a hydrant. Dash spills
trash/fish, overflows the toilet with cartoon poop/pee, or releases washing water.
Owners spend three seconds repairing after reaching the disturbed object; a
24-second safety limit restores abandoned objects. Ground mess expires, new effects are bounded,
and reset restores the entire square. Creature encounters and props must be
visible and playable through normal controls, not just debug arrangements.

Choices made for the first playtest: +50 versus the normal +10 reward, six incidents,
five-second dispatch, 25-second chase and six creatures. These are tuning values,
not claims of proven fun. The orange BOT PAL still represents a local companion;
real multiplayer, shared-bonus distribution and timed winners remain next-slice work.
