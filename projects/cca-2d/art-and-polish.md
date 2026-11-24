# Art direction and polish

Status: the user selected a South Park-like cutout direction for the Babylon
2.5D trial. The [phone mockup](visual-concepts/README.md) is a new visual proposal,
not approval of finished assets or a runtime capture. The separate
[local trial](babylon-local-trial.md) provides actual Babylon gameplay for review. It supersedes Pocket Arcade
Market's cute animals and pixel-grid production rules.

## Direction: scruffy cutout market

Original human troublemakers with flat paper bodies, plain oval eyes, tiny pupils,
deadpan mouths, angular hair and abrupt hinged movements. A battered market supplies
crooked stalls, cardboard fruit boxes, bins, uneven awnings and an unglamorous bank.
Humor comes from timing and reactions: smug dash, disgust, offended stare, wild
sliding legs and a guard trying to regain dignity.

Use muted tan, petrol teal, rust orange, asphalt gray and sickly green, with
small amber/cyan accents for action and ice. Keep paper grain restrained and
ground detail quieter than the actors. Avoid glossy toy materials, rounded
mascots, cozy scenery, realistic liquids and expensive lighting.

The South Park reference describes tone and cutout technique; create original
characters, costumes, voices and setting. Keep the humor suitable for the intended
6–14 audience. Existing concept images are historical, not parallel asset styles.

## Construction contract

Follow [Babylon scene construction](babylon-scene-construction.md). Flat texture
layers on simple planes form characters; low-complexity geometry gives the street
depth. Animation moves cutout joints and swaps facial parts. Simulation controls
ground position and slip state; a visual fall does not redefine collisions.

Generate source parts from an approved character sheet, not independent complete
frames with drifting proportions. Supply transparent head, torso, upper/lower
limbs or simplified single-piece limbs, hands and face variants with explicit
pivots, common scale, padding and front/back order. Use a shared atlas where practical.

Start with one player rig, one rival variation and one guard. Required poses:
idle, run, dash/puff, slip, fall/recover, caught and bank reaction. Stable foot
anchors and readable reactions matter more than frame count. Do not crop the
phone mockup into production textures.

A small environment kit contains ground tiles, one stall, boxes, bank and bin.
Author collision separately; texture scratches never become obstacles.
Keep provenance/licence and source assets separate from shipped atlases.
Only approved runtime assets ship; concept art stays outside the application bundle.

## What the mockup does not prove

The generated screen exaggerates character size and paper texture. It is a
close-up style reference. Normal play must show enough routes and warning distance;
overview must keep threats legible. The image contains illustrative shadows and
occlusion that need real depth tests, and its HUD text/buttons are painted,
not accessible or interactive UI.

No screenshot establishes animation quality, achievable startup cost or mobile
performance. Babylon provides rendering tools, not automatic art direction.
The construction guide's rendered scene gate is mandatory before expanding assets.

## Approval and polish loop

1. Review a real-size character sheet and face/limb parts against this direction.
2. Assemble one market corner in Babylon at close, play and overview zoom.
3. Play a short dash → puff → slide → recovery sequence with floating controls.
4. Capture portrait, landscape, iPad and desktop, including awkward overlaps.
5. Identify at most three concrete defects, fix and recapture.
6. Have the user judge the moving result before creating more characters or stalls.

Use feedback such as “the ice disappears beneath the cloud at overview zoom”,
not “make it more polished.” An independent reviewer checks clarity and artifacts;
the user decides aesthetic fit. A useful mockup must have a documented construction
path; a visual feature without one remains exploratory.

## Feedback and sound

Use abrupt pose changes, short limb swings, eye/mouth swaps and one controlled
puff. Slips can be broad and absurd while the loss of steering stays brief.
Fart/splash sounds are short, varied and rate-limited; no essential warning
depends on audio. Sound unlocks after a gesture and resumes safely after suspension.

Bank rewards and confirmed catches follow accepted host outcomes. Local dash
animation may predict the action, but cannot confirm a drop, score or hit.
Cosmetic hit-stop never pauses the network simulation. Respect reduced motion;
avoid camera shake, flash and automatic surprise zoom.

## Review rubric

Require readable silhouettes, consistent part proportions, stable anchors,
correct depth ordering, distinct hazard cues, clear ground contact and expressive
faces at actual phone size. Check with muted audio and reduced motion.
Record normal-speed footage of ordinary movement, three overlapping characters,
a stall crossing, slip recovery, zoom, bank and host-recovery overlay.

A failure in any of these categories is repaired in the small representative
scene before map/content expansion.
