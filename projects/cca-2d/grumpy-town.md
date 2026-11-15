# Grumpy Town interaction slice

Extend the local Babylon trial into a larger scrolling market while retaining the
floating joystick, one dash-and-drop action, pinch zoom and keyboard equivalents.
The intended feel is mischievous slapstick in a town of permanently unimpressed
shopkeepers. Multiplayer remains the following slice.

## Playable interactions

- Dash into a stocked fruit stall to tip its display and scatter fruit. Walking
  into it does not cause damage. The fallen fruit rolls, settles and makes the
  player skid; the same rule can apply to future human players.
- Its owner gets angry, visibly aims a warning, then zaps the marked position.
  Moving away dodges it; being hit makes the player temporarily tiny.
- The owner walks out to collect the mess, then returns and restocks. Another
  prank can interrupt this, but effects and debris have bounded lifetimes.
- Walk over a powder or zapper pickup to equip one use. The same dash button
  uses it: powder leaves a cloud causing dizziness and a cartoon puke puddle;
  a zapper miniaturizes characters in front. The next action returns to the
  normal fart drop. The HUD shows which prank is loaded.
- Dizziness reduces movement briefly rather than reversing controls. Mini,
  dizziness and puke poses expire. Characters recover and resume their jobs.

The world extends across several blocks, with six shops and their owners. Start
zoom is wider and overview zoom shows more town. Collision remains simple and
rule-driven; rendered props and animation do not decide gameplay.

## Development sequence

1. Implement and test deterministic stall damage, debris, pickup/effect lifetimes,
   dodgable retaliation and cleanup/restocking behind the existing local loop.
2. Render the larger town, toppled displays, rolling fruit, owner moods, warning
   zaps and temporary transformations; exercise the visible phone controls,
   build the SPA, capture actual gameplay and update the existing PR.

The implementation uses the existing Babylon renderer and original cutout assets.
A physics engine or extra buttons would add complexity without improving this
first interaction loop. Full competitive matches and Rallar hosting remain
separate from this local playtest.

## Proposed next gameplay loop: busy owners buy safety

The next design proposal gives cleanup a strategic purpose. An owner who is
cleaning is distracted. Once the business is in order, they watch the street;
seeing an actual prank triggers a readable pursuit and aimed zaps that cost a
small number of points. This chase/score loop is **not implemented in this slice**.

Use three clear states: cleaning, watching, chasing. Show cleanup progress and
make the transition back to watching visible. Require a witnessed prank rather
than punishing mere proximity. Chases need a range/time limit, telegraphed zaps,
a way to break sight, and brief protection after a hit. A busy owner should
finish cleaning before resuming enforcement; the current immediate retaliation
would need to change to test that promise.

Reward creating fresh trouble and taking risks elsewhere. Repeatedly knocking
over the same stall should not generate unlimited points or permanent safety.
Give recently harassed owners temporary resistance to repeated distractions.
Other owners can witness the mess even while its own owner is busy, creating
routes and opportunities for friends to distract, rescue or accidentally expose
each other. Distinguish temporary powder/mini effects from cleanup duties.

A first round could last about two minutes, with each player trying to reach a
mischief target; several players can succeed. Exact scoring and shared/personal
objectives remain a design choice. First prove that one prank creates a useful
window, a second owner creates a fair threat, and escaping feels earned.

## Proposed escalation: authority raids and rescue

A watching shopkeeper can visibly call the authorities after witnessing trouble.
The proposed sequence is a short interruptible alarm, a clearly marked arrival,
a local raid lasting roughly 20 seconds, then departure and a cooldown. It should
create a shared emergency without making the whole market unsafe indefinitely.
This raid/rescue system is a proposal, not part of the current playable slice.

Authorities catch and freeze players as expressive statues. Nearby playable
characters can thaw them through about one second of proximity, preserving the
existing controls; a visible timer automatically releases anyone left behind.
Test a six-second default against the user's roughly ten-second suggestion.
Frozen players can still wiggle or signal. Newly freed players need brief capture
immunity, and the catching authority must move on rather than camp the statue.

Separate penalties: ordinary shopkeeper zaps can reduce points, while authority
catches cause the temporary freeze. Avoid stacking a large loss, long freeze and
instant recapture. Rescuing should be worthwhile without allowing repeated
capture/rescue point farming. Shared survival with individual mischief targets is
the recommended starting hypothesis, not a confirmed choice; fully cooperative
scoring or competitive optional rescue remain alternatives for playtesting. Several players can still win a timed round.

First playtest only one bounded raid in a small district. Check that players see
why it arrived, can find an escape route, understand thawing, and voluntarily
rescue someone. Do not add large crowds before the simple chase, phone readability
and eventual host simulation budget are proven.

## Design status and playtest decisions

The user proposed both the busy-owner safety loop and authority freeze/rescue.
The current recommendation is individual mischief scores with shared survival
when raids arrive. The user asked which is most fun; that remains a hypothesis
to test, not an approved claim about player behavior. Keep several possible
winners, no elimination, modest rescue rewards and short recoverable setbacks.

Update [the development sequence](development-sequence.md) as decisions change.
Its next two slices are local chase/freeze/rescue proof, then real Rallar-hosted
multiplayer/recovery. Avoid implementing more content while the core motivation
is unsettled. Observe whether players change routes as cleanup finishes and
voluntarily rescue friends; those are stronger signals than raw prank counts.


## Variety direction

The user requested more different things in the square. The proposed set now
includes fruit displays, a central fountain, rolling parcel carts, laundry,
powder and a street toilet. Each should create a different temporary hazard or
cleanup duty. See [the game design](game-design.md#a-varied-town-square) for the
interaction matrix. The next local slice starts with fruit, fountain and cart;
the remaining ideas stay candidates rather than expanding the immediate scope.
