# Art direction and polish

Status: proposed direction, awaiting a visual reference and in-game approval.
No art assets are approved by this document.

## Direction: a paper-cut market caper

Use chunky illustrated animal thieves, toy-like wind-up guards, striped market
awnings, coin tubes, stamped price labels, and exaggerated loot bags. The world
looks assembled from coloured paper with dark ink edges and short offset shadows.
It is bright, mischievous, and tactile. It does not resemble the existing neon arenas.

True top-down movement uses slightly angled character illustrations so faces and
bags remain visible. Environment geometry stays orthogonal and readable; this is
not an isometric navigation or occlusion problem.

| Element    | Proposed rule                                                                        |
| ---------- | ------------------------------------------------------------------------------------ |
| Ground     | Warm cream and muted mint; low contrast, restrained paper grain                      |
| Players    | High-contrast silhouettes, large face/bag, dark plum outline                         |
| Guards     | Squarer silhouette, winding key, amber warning cone, distinct pursuit pose           |
| Banks      | Teal striped booths, clear deposit ring, mechanical receipt animation                |
| Loot       | Warm gold, simple sparkle, visible outline against every ground tile                 |
| Danger     | Coral plus a shape/animation cue; colour alone never carries the meaning             |
| Lighting   | Baked highlights and one consistent short shadow direction                           |
| Typography | One compact display face for headlines, one readable UI face; local licensed subsets |
| Texture    | Mostly large flat shapes; fine detail must survive actual phone scale                |

Palette starting points: cream `#F4E8CB`, plum `#332A43`, mint `#A8CBB7`, teal
`#247C78`, coral `#E96955`, and gold `#F3B941`. These are art colours, not evidence
of text contrast compliance. Choose text/background pairs after measuring contrast.

## What Phaser does and does not solve

Phaser gives this project sprite animation, texture atlases, cameras, input,
tweens, and scene lifecycle tools. That reduces the amount of engine plumbing
agents must create. See its official [animation](https://docs.phaser.io/phaser/concepts/animations),
[texture](https://docs.phaser.io/phaser/concepts/textures), and
[input](https://docs.phaser.io/phaser/concepts/input) documentation.

It cannot choose a compelling silhouette, fix incoherent generated frames, judge
whether an effect obscures a guard, or turn an attractive concept painting into a
readable moving game. It also does not guarantee smaller bundles than alternatives.
The recommendation is a fit judgement for this game, subject to the first slice's
measurements. Pin a tested engine version; do not mix examples from different majors.

## The visual approval loop

1. Explore two or three still directions showing the same gameplay composition:
   one runner, one guard, one bank, three obstacles, loot, and a minimal HUD.
2. Review each at phone gameplay size, not only as an enlarged illustration.
   Select one reference with the user before making a production asset set.
3. Build one representative corner in the real renderer. Add idle/run/dash/catch,
   one bank animation, and sound. This is the visual quality target for the game.
4. Capture the same seeded scenes on phone portrait, phone landscape, iPad, and
   desktop. Compare against the approved reference at the same display scale.
5. Have a separate reviewer identify at most three concrete visual defects per
   batch. Repair those, recapture, and ask the art owner to accept or reject them.
6. Expand the map and cosmetics only when the small scene passes. Recheck the
   approved scene after changes to assets, cameras, scaling, or effects.

“Make it more polished” is not an actionable agent task. A good task is: “The
guard warning overlaps the runner's feet at 360 CSS pixels; keep the contact point
visible and verify the same chase capture with reduced motion on and off.”

The lead agent owns visual consistency. The user selects the aesthetic and approves
the representative scene. Automated screenshot comparisons detect changes, not
beauty. No agent may approve its own work solely because it matches its own prompt.
If two focused revisions still fail the reference, diagnose asset, composition,
or animation failure separately. A tightly scoped human illustrator/animator pass
is a valid fallback; changing engines is not the default response.

## Production asset contract

Begin with one runner base, four cosmetic identity variants, one guard, one market
tile set, one bank, one loot family, and a small effects sheet. Variants must have
shape or symbol distinctions as well as colour. Qualify six readable identities
before raising the player cap to six.

Use Imagegen for exploration and approved source art. Use Game Studio's sprite
pipeline to request a complete animation strip from one approved seed, normalize
its frame size and shared foot anchor, and preview it in-engine. Generating every
frame independently invites proportion and costume drift.

- Starting sprite cell: 96 × 96 source pixels, displayed around 24–40 CSS pixels
  depending on the common playfield's size. Judge the smallest supported scale.
- Start with four facing directions. Mirroring is allowed only when the costume,
  lighting, and asymmetry still read correctly; eight directions must earn their cost.
- Starting animation inventory: idle, run, dash, catch, respawn, deposit reaction.
  Keep the run cycle short and readable; exact frame counts are production choices.
- Use transparent source images, consistent padding, foot anchors, and extruded
  atlas edges. Inspect halos, texture bleeding, repeated frames, and foot sliding.
- Pack approved runtime images into bounded atlases; start with 1024-square pages,
  increasing only after device checks. Compressed download size and decoded texture
  memory are separate budgets.
- Keep original generation output separate from shipped assets. A manifest records
  stable asset keys, frame bounds, anchors, provenance/licence, and intended usage.
- Never bake essential UI text, hitboxes, or navigation rules into generated art.
  Collision is authored independently and shown in a development overlay.

Only the chosen look and necessary runtime assets ship. Source sheets, alternates,
large concept art, and debug captures stay out of the production bundle.

## Game feel and sound

| Moment          | Visual feedback                                         | Audio feedback                     | Authority rule                                    |
| --------------- | ------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| Movement        | Foot bounce, short ground shadow, direction change pose | Restrained footsteps               | Local movement prediction allowed                 |
| Dash            | Squash/stretch and a short directional streak           | Quick cloth/air accent             | Predict pose; reconcile cooldown and position     |
| Pickup          | Token snaps toward bag after confirmation               | Short pitched tick, capped overlap | No confirmed score from a local overlap alone     |
| Guard notices   | Visible turn and warning symbol before pursuit          | Distinct alert chirp               | Telegraph timing is server-owned                  |
| Bank completes  | Receipt stamp and brief score transfer                  | Satisfying mechanical cha-ching    | Only on accepted deposit                          |
| Caught          | Comic bag pop, clear loss amount, respawn countdown     | Soft failure accent                | Cosmetic animation never delays shared simulation |
| Final countdown | Stable timer emphasis, visible route urgency            | Optional measured pulse            | Audio never carries the only warning              |

Do not pause the whole multiplayer simulation for hit-stop. If used, freeze or
accent only a brief cosmetic layer, and never obscure input or authoritative timing.
Avoid constant screen shake, bloom, full-screen flash, excessive particles, or
camera zoom that changes visible world information.

Audio starts from a user gesture and handles suspension/resume. Provide mute,
separate effects/music levels, reduced intensity, and a simultaneous-voice cap.
One short licensed loop can wait until after the first controllable frame; music
never blocks entry. Procedural Web Audio effects are sufficient for the first slice.

## Review rubric

Score each category 0 (broken), 1 (inconsistent), or 2 (meets reference), using
actual gameplay screenshots and short recordings. Release needs 2 in every category;
averaging must not hide a broken category.

| Category    | Evidence for a 2                                                                    |
| ----------- | ----------------------------------------------------------------------------------- |
| Identity    | A gameplay crop shows the market/caper theme without a title screen                 |
| Readability | Runner, guard, collectible, bank, and solid obstacle remain distinct at phone scale |
| Animation   | Stable size/anchor, readable action, no visible frame drift or sliding              |
| Feedback    | Pickup, danger, successful banking, and catch have distinct restrained cues         |
| Composition | Critical action remains visible above thumbs and outside HUD                        |
| Coherence   | Assets share outline, palette, shadow, texture, and perspective rules               |
| Comfort     | Reduced motion, muted audio, and a ten-minute touch session remain usable           |

Reference captures must include ordinary play, maximum bag/heat, a close chase,
simultaneous players near a bank, catch/respawn, reconnect, and results. Capture
normal speed video too: a still cannot prove timing or animation quality.
