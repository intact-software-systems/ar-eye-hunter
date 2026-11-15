# Cash Chase Arena — Babylon 2.5D direction

Design revision · 15 November 2026 · Working subtitle: **Market Mayhem**

## Intent and current status

Make a funny browser party game for ages 6–14 that friends want to replay on
phones, iPads and computers. Outsmart friends and guards through readable
slapstick: fart distractions, water, ice, slipping and absurd reactions.
Collecting and banking provide a reason to cross the market; funny interactions
are the experience to prove.

The user selected a **Babylon 2.5D trial**, a South Park-like cutout direction,
a larger scrolling and zoomable market, floating controls, combined dash-and-drop,
and **Rallar-only multiplayer with an appointed player as host**. Timed matches
must allow multiple winners. This pack records those choices; detailed tuning,
the exact shared-win condition and the rendered visual result remain proposals.

The [new smartphone mockup](visual-concepts/README.md) is generated concept
imagery, not a Babylon screenshot. The [construction guide](babylon-scene-construction.md)
maps its elements to actual rendering techniques and defines the proof required
before describing the look as achieved.

The [Babylon local trial](babylon-local-trial.md) now implements movement,
dash-and-drop, slipping, zoom and pause/reset in the [SPA](../../apps/cca-2d/README.md).
It replaces the old Phaser entry and includes actual gameplay captures. Collection,
banking and multiplayer are absent from this focused trial. The historical CCA
server prototype is independent; the new app does not connect to it.
Keep this directory name for continuity; “2D” no longer specifies the renderer.

## Read the pack

| Document                                              | Owns                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| [Local trial](babylon-local-trial.md)                 | Implemented controls, actual captures and current limits     |
| [Game design](game-design.md)                         | Pranks, guards, objective, shared wins and fun tests         |
| [Art and polish](art-and-polish.md)                   | Cutout identity, asset production and visual review          |
| [Babylon construction](babylon-scene-construction.md) | How the mockup can be built; rendering feasibility and proof |
| [Mobile and controls](mobile-and-controls.md)         | Camera, zoom, floating controls and device acceptance        |
| [Architecture](architecture.md)                       | Player authority, Rallar transport and host recovery         |
| [Development sequence](development-sequence.md)       | Only the next two concrete slices, tools and gates           |

## Approaches and decisions

| Approach                                               | Strength                                                       | Tradeoff                                                       | Decision                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Phaser with flat cutout art                            | Existing practice foundation; straightforward 2D               | Less natural depth and camera flexibility                      | Valid alternative if the Babylon trial misses its budgets |
| Babylon 2.5D with paper characters and simple geometry | Shallow depth, orthographic zoom, expressive layered animation | Rendering/asset work and phone performance need proof          | Selected; local trial implemented                         |
| Fully modeled 3D characters and physics chaos          | Physical spectacle                                             | More rigging, loading and unpredictable collision work         | Outside the first trial                                   |
| Separate game server                                   | Independent game authority                                     | Additional service to operate                                  | Superseded by the user's Rallar-only requirement          |
| Appointed browser host                                 | Rallar is the only multiplayer backend                         | Trusts the host; suspension and migration become game concerns | Selected, with recovery as an early feasibility gate      |

The SPA still needs static HTTPS hosting. No separate CCA simulation service,
external multiplayer provider, mandatory TURN service or runtime AI is part of
the target deployment. Rallar remains the authority for membership and host
appointment; the appointed browser owns game rules.

## Success criteria

- The same single action can escape danger and set up a funny interaction.
- Players understand why they slipped and regain control quickly.
- A phone user can navigate, zoom, prank, collect and bank without developer help.
- Multiple players can win a timed match; results come from accepted game state.
- A physical phone can host while rendering without unacceptable heat or stutter.
- Host disappearance produces a clear pause/recovery or interruption, never two
  conflicting matches or fabricated results.
- A real Babylon capture demonstrates the selected look and measured loading.

No production deployment or broad gameplay expansion is authorized by a mockup.
The next step is phone feedback on the local trial, followed by Rallar host recovery.
