# Mobile, tablet, and desktop play

Status: target layout for the Babylon trial. Generated art is not measured UI or
physical-device qualification. The [local Babylon trial](babylon-local-trial.md)
implements these basic controls; the existing Phaser layout is historical practice.

## Full-screen camera and zoom

Use an edge-to-edge Babylon canvas, a fixed three-quarter orthographic camera
and automatic follow with modest look-ahead. No manual orbit or aiming is needed.
The world continues beneath compact HUD and floating controls. Retire the fixed
square viewport and opaque control deck.

Zoom in for faces and action, out for route overview. Offer +/− buttons on every
device, pinch on unoccupied canvas, and mouse wheel/keyboard equivalents.
Change orthographic bounds, not simulation scale or movement speed. Start with
three bounded presets (close, play, overview), interpolating visually and keeping
the local player's ground anchor in view. Exact bounds require the first trial.

All players get the same zoom range and maximum ground-information radius.
Aspect ratio changes the rectangular crop; do not promise identical views on a
phone and ultrawide screen. Limit ground visibility to the shared maximum radius,
using a clearly visible distance fade/mask at extremes if needed. Do not reveal
distant players/hazards merely because the display is wider. Test this compromise
with portrait, landscape and wide desktop before claiming competitive parity.

Keep near foreground stalls low or fade the obstructing decoration when it hides
a runner; never hide the solid obstacle's ground footprint. Overview simplifies
small effects and preserves readable player/guard symbols.

## Floating touch controls

The bottom **quarter** is a placement envelope, not a reserved opaque panel.
At 390 × 844 CSS pixels, start with a 104-pixel joystick and 82-pixel DASH + DROP
button near opposite lower corners. Keep a 42-pixel puck, safe-area padding and
at least 12 pixels between independent targets. Primary actions must remain at
least 56 pixels in constrained layouts; zoom/menu targets start at 44 pixels.

These are intended CSS sizes. The mockup's larger painted circles are not measured
hit targets and must not be copied by scaling the screenshot.

| Action        | Touch                                              | Keyboard/mouse                    |
| ------------- | -------------------------------------------------- | --------------------------------- |
| Move          | Floating joystick constrained to lower-left region | WASD/arrows                       |
| Dash-and-drop | One large button, one edge per press               | Space or primary click outside UI |
| Collect       | Automatic                                          | Automatic                         |
| Bank          | Proposed stationary dwell inside bank ring         | Same rule                         |
| Zoom          | +/− or two-finger pinch on free canvas             | +/−, wheel or visible buttons     |
| Menu          | Compact visible control                            | Escape or visible control         |

Track joystick, action and pinch pointer identities separately. A second touch
on DASH must never initiate zoom. Pinch cannot begin from a pointer captured by
a control. Changing zoom must not release a held joystick accidentally.
Disable page gestures only where needed for game controls/canvas, keeping ordinary
menu scrolling and browser accessibility available.

Offer mirrored controls, local position adjustment and reduced motion.
Tablet controls stay within comfortable thumb reach; desktop has compact hints.
No desktop-only aim, sprint, jump or extra world-information range.

## Readability and lifecycle

HUD: timer, banked cash, bag, small menu; show goal progress when target-win mode
is implemented. Keep critical action above thumbs and away from zoom controls.
No permanent debug dashboard. Show drops' warning, guard reaction and slip recovery
with pose/symbols as well as color; all essential cues work with sound muted.

Use the dynamic viewport and actual safe-area insets. Recompute input mapping on
resize/orientation change; neutralize held inputs and require fresh contact.
Handle pointer cancellation, release outside bounds, blur, menus and connection
loss. Never let a missing final packet keep a runner moving or auto-banking:
the host expires control freshness.

Menus do not pause other players. Host suspension may pause the whole match for
recovery; show “Finding a new host” and then “Resuming” or “Round interrupted”.
The local timer must not pretend a match continued while authority was absent.

## Device evidence

Initial reference classes: iPhone 12/Safari, iPad 9th generation/Safari,
Pixel 6a/Chrome, and current desktop Chrome, Firefox and Safari. These are proposed
test targets, not measured minimum specifications. Record exact OS/browser,
power mode and thermal conditions.

Test 360 × 640 and 390 × 844 portrait, 844 × 390 landscape, tablet orientations
and wide desktop. Require touch-only and keyboard-only complete flows, movement
plus dash, pinch without action leakage, safe-area/toolbar changes, rotation,
audio suspension and ten-minute play comfort.

Test both host and non-host phone backgrounding, app switching, lock and reconnect.
Browser emulation helps check layout but cannot qualify real Safari suspension,
thermal performance or physical multitouch. No device is certified by the mockup.
