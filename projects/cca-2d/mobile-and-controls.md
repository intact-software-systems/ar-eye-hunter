# Mobile, tablet, and desktop play

Status: proposed support and acceptance contract. No device support is yet qualified.

## Support intent

Smartphones and iPads are full players, not lobby-only or spectator devices. Both
portrait and landscape must support active play. Keyboard/mouse is first-class on
larger screens, and an iPad may switch between touch and attached keyboard/trackpad.
No installation, fullscreen permission, orientation lock, or pointer lock is required.

First qualification devices: a physical iPhone 12-class phone with Safari, a
physical iPad 9th-generation-class tablet with Safari, a physical Pixel 6a-class
Android phone with Chrome, and desktop Chrome/Edge, Firefox, and Safari. These are
proposed reference classes, not measured minimum specifications. Record exact model,
OS, browser version, refresh rate, and power mode during qualification; replacements
must be explicit, and oldest supported OS/browser versions are set from that evidence.

Test CSS viewports including 360 × 640 portrait, 844 × 390 landscape, 768 × 1024
tablet, 1024 × 768 tablet, and 1440 × 900 desktop. Add real safe areas and browser
toolbar states; a viewport preset is not a physical-device certification.

## Camera and responsive layout

Use a centered square world frame with a fixed 12 × 12 world-unit view, following
the runner without manual aiming or camera rotation. All players see the same
world area regardless of device shape. Surrounding space contains controls and
restrained decoration, never extra world visibility. A small shared schematic may
mark banks, the jackpot, and the local player; do not reveal extra off-screen enemies.

Portrait phone sketch:

```text
+--------------------------------+
|  1:42    Banked 120    Bag 16   |
|--------------------------------|
|                                |
|       SQUARE GAME VIEW          |
|    runner / guards / stalls     |
|                                |
|--------------------------------|
|       Jackpot opens in 3       |
|  [movement pad]       [Dash]    |
|                       [Bank]    |
+--------------------------------+
```

Landscape phone sketch:

```text
+--------------------------------------------------+
| banked/bag | time + short objective | settings     |
|           +------------------------+              |
| movement  |   SQUARE GAME VIEW      | Dash / Bank  |
| pad       |   same visible world   |              |
|           +------------------------+              |
+--------------------------------------------------+
```

Tablet uses the same frame and controls within comfortable thumb reach, rather
than stretching the joystick to the screen edge. Desktop uses the square frame
with compact DOM HUD and contextual key hints. A wide monitor provides larger
pixels, not a wider field of view. Do not add a permanent sidebar dashboard.

Aim for at least 288 CSS pixels per side for the playfield after safe areas and
browser chrome. Portrait controls sit below it; landscape controls sit beside it.
If a split-view or keyboard reduces available space below the supported minimum,
show an actionable resize/rotate/close-keyboard message and neutralize input. Never
distort the scene, quietly crop threats, or pretend the shared match has paused.

Resize/orientation changes recompute the canvas and input mapping together. Clear
held input, retain authoritative match state, and resume only after fresh input.
Test rotation during a chase and while holding Bank.

## Current playable layout

The first Phaser app reserves the bottom **25% of the dynamic portrait viewport**
for controls, including the bottom safe-area inset. At 390 × 844 that is 211 CSS
pixels. A 112px joystick sits beside two 72px action targets with a 16px gap.
The square world is sized independently above it; it never extends below thumbs.
Landscape places movement and actions beside the square world. Desktop keeps
keyboard controls and visible action buttons. Physical comfort still needs testing.

## Selected portrait reference

The selected pixel-art direction has a [measured browser composition](visual-concepts/pocket-arcade-layout.html)
and [captured phone image](visual-concepts/pocket-arcade-refined.jpg). This earlier reference has been superseded for control-deck height by the playable layout above. The reference
is fixed at 390 × 844 CSS pixels, with these app-content coordinates:

| Element           | Bounds or rule                                                 |
| ----------------- | -------------------------------------------------------------- |
| World             | x=15, y=96, width=360, height=360; border outside world bounds |
| Event strip       | x=15, y=472, width=360, height=32                              |
| Movement pad      | x=32, y=594, diameter=112; thumb puck=44                       |
| Dash target       | x=266, y=574, width=72, height=72                              |
| Bank target       | x=266, y=670, width=72, height=72                              |
| Action spacing    | 24 CSS pixels between target bounds                            |
| Control exclusion | Entire control deck below world; no gameplay beneath thumbs    |

These are measured layout dimensions, not physical-device comfort certification.
The reference intentionally has no device bezel or simulated OS chrome. Production
must reserve actual `env(safe-area-inset-*)` values and use the available dynamic
viewport; 844 pixels is not assumed to remain available beneath browser toolbars.
Do not scale the whole screenshot to fit smaller phones: recompute the square and
control positions, keeping action targets at least 56 pixels and gaps at least 12.
At 360 × 640, start with a 288-square world and a compact lower deck; qualify it
with real thumbs. Landscape moves controls to the sides. Tablet/desktop preserve
the same 12 × 12 world view and use the existing layout rules above.

The HTML is a static measurement fixture, not responsive app code or input logic.
Its labels omit the menu to focus this composition; the implemented HUD still
needs the accessible menu described below. No control, image or caption here
establishes multitouch, camera, network or gameplay correctness.

## Equal actions across inputs

| Action        | Touch                                           | Keyboard/mouse                                   |
| ------------- | ----------------------------------------------- | ------------------------------------------------ |
| Move          | Floating joystick constrained to a reserved pad | WASD or arrow keys                               |
| Dash          | Large dedicated button                          | Space or primary mouse button                    |
| Bank          | Hold dedicated button while in bank zone        | Hold E or click-and-hold the visible Bank button |
| Menu          | Visible menu button                             | Escape or click                                  |
| Ready/rematch | DOM buttons                                     | DOM buttons with keyboard focus                  |

Dash follows movement or last facing on both devices. Mouse aiming, click-to-move,
camera steering, and additional desktop abilities are outside the first release.
Bank never activates merely because a thumb crosses a zone. Auto-pickup has the
same radius for everyone. Mouse and keyboard can operate together, but each action
has one normalized state to avoid double activation.

Default to 72 × 72 CSS pixel Dash/Bank targets with 16 pixels separation and a
112-pixel movement pad with a 44-pixel puck. For constrained layouts, retain at
least 56 × 56 primary action targets and 12 pixels separation. Make pad/button
placement adjustable within reserved control regions and offer a mirrored left-handed layout. Save preferences
locally through Rallar Data. No layout option may cover essential gameplay.

Track joystick and action pointer identities independently. Movement plus dash or
bank must work with simultaneous contacts. Handle pointer capture, release outside
the control, `pointercancel`, blur, page hide, orientation change, disconnect, and
opening a modal. Each clears held input; a fresh press is required after recovery.
Prevent page scrolling/zoom gestures only on active game controls, preserving normal
menu scrolling and browser accessibility elsewhere.

Never bind a simulation action to a render frame count. Repeat-held movement is
replaceable state; dash is a distinct action edge; Bank is an authorized held state
whose progress the server owns. A retransmission cannot create another dash.

## Interface and onboarding

The landing page offers Practice and Play with friends with a clear load state.
Practice can run locally without an account; it is visibly solo. Multiplayer uses
existing Rallar authentication and room entry. Preserve invitation context through
sign-in. Anonymous multiplayer is not assumed to exist and is not a requirement
for the first implementation.

During asset loading, show actual phase/progress and a useful retry action. Do not
hide minutes of network work behind an unchanging spinner or fabricated percentage.
The room screen shows people and Ready, with secondary settings collapsed. Technical
transport and authority diagnostics are available only in an operator surface.

Introduce pickup and bank through a 20–30 second practice route using the actual
controls and rules. Do not put a multi-page tutorial between a returning player
and their friends. Newcomers can return to practice from the room.

Menus, forms, settings, results, and room controls are semantic DOM UI with focus
management, accessible names, and keyboard navigation. Gameplay labels use icons
and text; high heat and guards use shape/motion as well as colour. Provide reduced
motion, high-contrast cues, remapping, HUD text scaling, and sound controls. Do not
claim a real-time chase is fully screen-reader playable without a separately tested
interaction design.

## Reliability visible to the player

Show Connecting, Reconnecting, and Round interrupted with concrete actions. Never
show “banked” merely because a message was queued. During an ambiguous deposit,
show its pending state until a fresh authoritative snapshot resolves it.

Opening a menu does not pause other players. Say so and neutralize movement;
guards can still catch the runner. Phone app switching follows the same rule.
Server input expiry makes this safe even when the browser cannot send a final
neutral message. The [recovery policy](architecture.md#disconnection-and-recovery)
defines the consequence.

## Device acceptance

- Play a complete round and rematch using only touch, then only keyboard/mouse.
- Run a mixed phone/iPad/desktop round against the same server and compare results.
- Hold movement plus dash, release outside a control, rotate, and resume without
  stuck movement or duplicate actions.
- Open/close the on-screen keyboard, change browser toolbar visibility, and test
  safe areas without hiding the playfield or moving hit targets away from visuals.
- Background for 3 seconds, return; background beyond the grace period, return;
  switch Wi-Fi/mobile data; resolve each case as specified.
- Suspend/resume audio and mute it without losing essential information.
- Play ten minutes on each phone and tablet; observe heat, frame pacing, thumb
  fatigue, missed buttons, readability, and battery/power-mode effects.

Automated [Playwright emulation](https://playwright.dev/docs/emulation) supports
layout and browser-behavior checks. It does not establish physical multi-touch,
thermal performance, mobile networking, or Safari lifecycle behavior on an iPhone.
Those require actual hardware and captured evidence.
