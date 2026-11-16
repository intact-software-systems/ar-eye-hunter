# Grumpy Town interaction and raid trial

The local Babylon playground now tests **make trouble, buy time, escape, rescue**.
It preserves floating movement, one dash-and-drop action and zoom. The orange
**BOT PAL** is a simulated companion; this is not multiplayer or a complete match.

## What is playable

| Interaction          | Effect                                                                      | Cleanup and counterplay                                                                                          |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fruit stall          | Dash tips a stocked display and scatters six slippery pieces                | Its owner gathers fruit and restocks; tidy neighbours can chase                                                  |
| Fountain             | Dash knocks the nozzle into a sweeping jet                                  | Water pushes the player and reduces traction; the apple owner repairs it                                         |
| Parcel cart          | Dash releases it along a short route, obstructing the street                | The pear owner follows and retrieves it; the cart returns to its starting place                                  |
| Powder pickup        | The next dash leaves a cloud; exposed characters get dizzy and briefly puke | Dizziness slows movement without reversing input; cloud and puddle expire                                        |
| Zapper pickup        | The next dash shrinks visible owners in front for six seconds               | Mini owners move/clean slowly, then recover                                                                      |
| Bins and old fish    | Dash tips rubbish or scatters slippery fish                                 | The assigned owner puts the object back in order                                                                 |
| Public toilet        | Dash overflows cartoon poop and pee                                         | Puddles stain and slip; the owner repairs the toilet                                                             |
| Hydrant              | Dash releases washing puddles                                               | Water clears stains; the owner repairs it                                                                        |
| Birds, dogs and cats | Birds drop poop, dogs spray pee, cats spit puke after a fixed warning       | Dodge, wash off, or lure a provoked attack into residents/police                                                 |
| Petty-rule residents | Dash the bell, flowers, barrier, vacuum, statue, laundry or squeaky toy     | Brief distraction, flying wig, queue shuffle, burp, silly statue, washing hose or stolen hat; recover and return |
| Barbecue fire        | Dash starts a localized fire, earns +20 and dispatches the grumpy fire crew | Visible witnesses pursue; crew warn, extinguish, wash/push and return                                            |
| Big Stink pickup     | Existing dash drops a bomb with a two-second, six-unit warning              | Solid cover blocks the splash; at most twelve temporary patches; water washes stains                             |
| Café samples         | Inspector warns, then performs a six-second sweeping vomit spectacle        | Dash the umbrella to deflect; waiter saves cake, then uses a tiny bucket                                         |
| Fart drop            | A witnessed dash attracts attention without needing to damage stock         | Escape, break sight, or create a cleanup duty                                                                    |

Fresh object/stall/fountain/cart trouble and provoked animal collateral award 10 points. Each source has a 30-second
reward cooldown, and hitting an already damaged source gives no additional points.
The fruit owner also maintains the fountain; the pear owner retrieves the cart.
These shared duties create route choices with the existing six NPCs.

The cart follows a bounded scripted path, rather than general physics. It does
not yet scatter parcels. Water affects the player and slows owners/guards; it
does not simulate fluid or push other props. Toilet overflow and temporary brown/yellow/green stains are implemented. Laundry reactions and a washing hose are implemented; clothing transformations remain a later candidate.

## Inhabited square and major incidents

The 48×48 town now has thirteen varied buildings around the original market:
fire station, bakery, café, post office, florist, newsstand, clockmaker, library,
council offices and terraces/balcony homes. Eleven furniture footprints add benches,
mailbox, bus stop, bikes, planters, café tables, noticeboard and lamps. Buildings and
furniture are solid and participate in sight and travel routing; they are not
promises of indoor gameplay. Named personality props and the barbecue/sample tray
provide the new interactions.

Major incidents award +20 and one trouble mark. Fire/sample sources and the bomb
pickup have 45-second cooldowns. One event runs at a time; a queue retains one
request of each kind, so accepted rewards cannot discard their consequences.
Police waves retain their own lifecycle. Each incident has bounded cleanup and
reset clears crew, pending events, stains and source cooldowns.

The original town-and-spectacle discussion below preserves design rationale.
The [implementation plan](town-square-expansion.md) distinguishes delivered behavior
from physical-device and multiplayer evidence still required.

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

## Brainstorm: petty rules and ridiculous reactions

The user endorsed this set, then requested implementation. The current scene now contains a first playable version of every personality. The table preserves the original comic intent; the playable behavior and tuning above are authoritative for this trial. Give each grump one visible pet peeve, one exaggerated reaction and one
weakness players can use. Mix tidy, quiet, orderly and self-important personalities
so encounters change decisions instead of adding interchangeable hazards.

| Grumpy personality     | Prank and comic reaction                                                                      | Gameplay opportunity                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Silence fanatic        | Ring a bicycle bell; the resident shouts QUIET through a huge megaphone, upsetting neighbours | Draw attention toward the noise and start a short NPC argument         |
| Perfectionist gardener | Scatter carefully arranged pots; pollen causes a giant sneeze that launches their wig         | The gardener chases the wig while players escape                       |
| Queue tyrant           | Knock a queue barrier sideways; residents insist on reorganizing a queue that leads nowhere   | Briefly redirect pedestrian flow, keeping escape routes open           |
| Overzealous cleaner    | A cleaning vacuum sucks up mess, swells, then burps a clearly warned fart cloud               | A cleanup job can briefly inconvenience nearby grumps and police       |
| Self-important mayor   | Dash into the statue plinth to turn its solemn face silly; the mayor frantically covers it    | Draw residents to a public distraction with an obvious reset job       |
| Fussy washer           | Disturb clean laundry; the resident pursues with a hose and accidentally washes everyone      | Clear stains and interrupt a pursuit with a bounded water sweep        |
| Nosy window watcher    | A squeaky toy makes the watcher lean out; a bird steals their hat                             | Temporarily remove a lookout without another stun mechanic             |
| Grumpy animal rivalry  | A dog steals a broom or a cat occupies the mayor's chair; residents blame each other          | Create lively background encounters; no score for unprovoked accidents |

Suggested first experiments: silence fanatic, sneezing gardener and overzealous
cleaner. They offer noise diversion, a chase for a displaced object and a cleanup
backfire, respectively. A possible chain: bell → loud complaint → startled dog →
soiled resident → vacuum cleanup → fart burp → two grumps arguing while the player
escapes. Bound the chain, telegraph effects and avoid repeated rewards for one cause.

Keep movement and dash/drop as the only required actions. Pet peeves should be
readable from objects, poses and short signs without requiring children to read
dialogue. A grump can briefly look smug when order is restored, making the next
absurd upset more expressive than constant anger. These ideas still need sequencing
and playtesting; they are not promises of proven fun.

## Brainstorm: a recognizable town and big comic incidents

The user wants a fuller, more varied regular town square: houses, booths and
familiar town institutions. They also proposed a small fire that awards a bonus
and brings a grumpy fire department plus witnesses, a large-radius poop bomb,
and an extravagantly absurd vomit scene. The user subsequently requested a documented plan and implementation of this
direction. These three incidents are now playable; see [the expansion plan](town-square-expansion.md) for implementation and validation. The earlier personalities have user support; this section
preserves the design rationale; the expansion plan now defines implementation.

### Town identity and everyday life

Build a recognizable civic square around the fountain/statue, with four distinct
edges: government and municipal offices; a shopping street with bakery, café,
florist and newsstand; a service lane with fire station, refuse area and delivery
access; and a residential edge with terraces, balconies, laundry and window
watchers. Vary rooflines, facade materials, heights, awnings and shop windows.
Use benches, bus stop, mailboxes, bicycle racks, café tables, planters and notice
boards to make the spaces recognizable. Keep broad routes and multiple exits;
foreground furniture must not become a solid obstacle maze.

Use a mix of scenic facades, reactive details and a smaller set of consequential
interactive props. Residents drink tea, queue, deliver parcels and tend flowers
between disturbances. Their routines give pranks a visible setup and recovery.
Short signs and absurd local rules establish grumpy identity without dialogue
reading being required. Maintain the selected restrained cutout art direction.

### Small fire and grumpy fire department

Proposal: a contextual prank at designated props creates one small cartoon fire,
awards a fresh-incident bonus and visibly raises a fire alarm. Fire response follows
the fire; only residents with sight of the act identify and chase the culprit.
Witness complaints need a visible pointing/recognition cue. Firefighters emerge
from the fire station, prioritize extinguishing, then grumpily restore the site.
Their warned hose sweeps push/slip and wash people, including police. The truck
occupies a marked service bay without sealing the square's escape routes.

Comedy comes from an excessive response to a tiny incident: giant hoses, a
soaked mayor, a firefighter sliding backward and an argument over wet paperwork.
Keep fire localized and bounded, without runaway building destruction. The bonus
cannot be retained while cancelling its response. One source cannot repeatedly
farm rewards; the exact bonus, incident contribution and response duration are
unsettled tuning choices. Firefighters restore/wash; police pursue/freeze.

### Large-radius poop bomb

Proposal: a rare pickup loads the existing dash/drop action with a giant wobbling
poop bomb. A visible countdown and expanding footprint let everyone escape before
a broad cartoon splat coats exposed actors, props and a limited set of slippery
patches. Solid scenery provides cover. Grumps stop to clean; protected/frozen
players do not accumulate new immobilization. Water provides an immediate remedy.

A spectacular visual radius should not become an equally large impassable or
unavoidable slow zone. Leave traversable routes, cap the persistent patches and
bound their lifetime. Credit the initiating prank once; reactions and cleanup do
not each create another reward. Avoid permanent brown screen overlays or a new
inventory/aiming UI. Acquisition frequency, radius and reward remain proposals.

### Absurd vomit set piece

Proposal: a pompous food inspector samples something at a café, insists everything
is perfectly fine, visibly turns green and produces an impossibly long cartoon
vomit stream while trying to remain dignified. The warned stream sweeps a short
sector; players sidestep or lure a pursuer into it. An umbrella redirects a spray,
a waiter shields the cake and a cleaner arrives with an absurdly tiny bucket.
Borrow theatrical escalation and deadpan reactions, using original characters,
staging and dialogue rather than recreating a film scene.

Use exaggerated colored shapes and expressive cutouts. Bound duration, slippery
patches and secondary reactions so one event cannot turn into an endless sickness
loop. Any secondary victim reaction is brief and cannot recursively restart the
same event. Keep escape controls available.

### Variety, pacing and development choice

Ordinary pranks should stay frequent; major comic incidents should create a brief
peak followed by recovery. Start by allowing one major spectacle at a time,
visibly queueing another emergency if it is already committed. Police/animal
interactions can still overlap, but not erase all safe routes or repeatedly freeze
players. Exact scheduling and overlap policy require a separate rules decision.

The subsequent implementation request selected the town pass and all three incidents for this trial. Fire adds a place, witnesses, arrival, a different response and useful
washing counterplay. The two-slice plan owns this work; the Rallar hosting/recovery gate remains documented separately.

### Further brainstorm: town character and connected reactions

These are additional design proposals, not claims about implemented behavior or
proven fun. Keep the existing implementation sequence; evaluate these connections
in playtests before expanding the content backlog.

Three possible emphases are a larger decorative town, more independent prank
stations, or a town whose ordinary routines and emergency responses interact.
Recommend the third: recognizable surroundings establish the joke, and connected
reactions let players invent escapes with the existing controls. Extra scenery
supports that approach without making every doorway an interaction.

- Give each street a recognizable silhouette and resident routine: crooked
  terraces with laundry, a tidy bakery queue, mismatched market booths, a solemn
  municipal frontage, and a cramped service yard. Vary building heights and roof
  shapes while preserving broad routes, shortcuts and camera visibility.
- Make fire an excessive response to a tiny incident. A barbecue emits a small
  cartoon flame; a disproportionately serious crew arrives. Witnesses visibly
  recognize the culprit, while firefighters prioritize the incident. A hose can
  wash poop away and interrupt a pursuit. Wet paperwork and a drifting wig are
  comic reactions, not additional loss-of-control penalties.
- Make the big poop bomb a rare social event. Its obvious warning gives players
  a choice to flee, take cover, or lure a pursuer toward the splash. Decorate faces,
  signs and awnings with bounded splats; leave the playfield readable. Washing
  provides a useful destination after the gag, rather than prolonging punishment.
- Stage the café incident around exaggerated dignity: an inspector turns green,
  a waiter desperately protects one immaculate cake, an umbrella deflects the
  stream, and a cleaner brings a tiny bucket. Keep a readable playable sequence,
  not a cutscene that takes control away.
- Test one connected sequence first: poop blast soils a resident; a fire hose
  washes them but sends their hat toward the café; the waiter protects the cake
  while a pursuing officer has to change route. Secondary reactions award no
  repeated points and cannot generate unbounded new emergencies.

Judge the connection by whether children can explain what caused it, deliberately
use it to escape or help a friend, and regain a clear route quickly. Gross-out
effects supply the punchline; anticipation, choices and grumpy reactions should
make repeating the encounter enjoyable. A whole-town alarm crescendo remains a
later possibility, contingent on readable smaller combinations.

### Brainstorm refinement: routines make the spectacle funny

The latest discussion reinforces the ordinary-town setting and the three big
incidents. The following additions are proposals for playtesting, not a new
implementation commitment or a change to the multiplayer delivery sequence.

| Place | Everyday setup | Proposed comic payoff and player choice |
| --- | --- | --- |
| Bakery and café | A perfect queue and an immaculate cake | A warned spray disrupts the queue; players choose the umbrella route or the open street while the waiter saves the cake |
| Residential terraces | A resident sweeps their doorstep and another watches from a balcony | A passing splash interrupts both routines; their exaggerated complaints reveal who witnessed the prank |
| Post office | A clerk sorts parcels into absurdly precise piles | A disturbed trolley creates a short cleanup diversion and a route choice, without closing the street |
| Fire station and service lane | Firefighters polish equipment beside a tiny barbecue | A small flame earns its bonus once and summons an excessive hose response; players can use the washing water to remove stains |
| Public toilets and flower stalls | An attendant demands spotless paving | A rare Big Stink warning makes players choose cover, escape or a risky lure; the cleanup crew restores the site afterward |

The strongest comic pattern is setup, visible warning, disproportionate reaction,
then a short recovery. A resident should sometimes be smug or content with their
perfectly ordered business: constant shouting removes the contrast that makes
the next upset funny. Give the town small visual jokes such as a NO SMILING sign,
a queue for a closed booth and a fire crew polishing an already spotless truck.

Keep major incidents earned and legible. The initiating player gets one reward;
secondary reactions create escape or rescue opportunities rather than multiplying
score. Fire summons firefighters even without witnesses, while identifying the
culprit requires sight. The poop bomb can stain its thrower too, making its warning
and cover useful. The café spectacle stays playable throughout, with exaggerated
cutout streams and expressions rather than realistic bodily detail.

For a first connected playtest, prefer one simple cause and consequence: a poop
blast dirties a pursuer, then a fire hose washes them and forces a route change.
Only add the flying hat, queue argument or café interruption if players can still
read and deliberately exploit that first connection. Town density should come
from varied facades and routines around broad streets, with useful alleys and
clear landmarks, rather than filling every free patch with collisions.

Give the three incidents distinct tactical purposes in the next design discussion:
fire summons mobile water and changes pursuit routes; Big Stink creates a warned
choice between cover and escape and occupies cleaners; the café stream creates a
moving obstacle that players can redirect. Their shared reward structure must not
make them feel like three differently colored explosions. These are intended play
experiences to evaluate, not newly verified capabilities.

Make the ordinary square readable at three distances. Zoomed out, the clock/council
frontage, fountain, striped market and fire station identify routes. At playing
distance, awnings, doorsteps, queues and props explain what can react. Close up,
faces, furious gestures and absurd signs deliver jokes. Proposed extra character
details include a municipal clerk protecting wet forms, a barber guarding an
elaborate hairdo, and a bus-stop queue that solemnly reforms after every disruption.
Do not make every decorative house or booth another mandatory interaction.

An open design choice is whether the largest incidents are rare opportunities
players discover or deliberate plans they prepare. Recommend discoverable,
well-marked opportunities first: they preserve immediate play for younger players
and the existing controls. Later, test whether experienced friends enjoy arranging
two compatible incidents together. Keep the current implementation sequence;
this brainstorm does not authorize another content slice ahead of reliability.
