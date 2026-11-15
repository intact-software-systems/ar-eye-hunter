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
| Fart drop | A witnessed dash attracts attention without needing to damage stock | Escape, break sight, or create a cleanup duty |

Fresh stall/fountain/cart trouble awards 10 points. Each source has a 30-second
reward cooldown, and hitting an already damaged source gives no additional points.
The fruit owner also maintains the fountain; the pear owner retrieves the cart.
These shared duties create route choices with the existing six NPCs.

The cart follows a bounded scripted path, rather than general physics. It does
not yet scatter parcels. Water affects the player and slows owners/guards; it
does not simulate fluid or push other props. Laundry, toilet overflow and
cosmetic clothing remain candidates, not implemented content.

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

Three witnessed dash actions start a visible **four-second call**. The caller is
marked; dash nearby, give it a cleanup duty or make it dizzy to interrupt the call.
Four seconds leaves a usable window after the dash's three-second cooldown.

If the call completes, three grumps enter from the south for 20 seconds. A dashed
district boundary marks their 12-unit pursuit area. They aim at a fixed red target
for 0.7 seconds. Escape the target or leave the district; being hit freezes the
target for six seconds without deducting points. Guards ignore frozen/protected
targets and move on after their firing cooldown. A finished raid leaves a
12-second quiet period; an interrupted call leaves six seconds.

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
slices concrete: phone feedback on this loop, then Rallar hosting and recovery.
