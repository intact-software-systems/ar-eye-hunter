# Grumpy Town — Babylon cutout playground

A local **Grumpy Town** playground in Babylon.js **9.36.0**. Dash into displays,
scatter slippery fruit, tip bins, spill old fish, overflow a toilet, break the
fountain/hydrant and release a parcel cart. Birds drop poop, dogs spray pee and
cats cough up puke; lure their warned attacks into pursuers. Busy owners
clean; tidy neighbours chase and zap away points. Authorities freeze characters
during short raids. The orange BOT PAL demonstrates proximity rescue. Walk over powder or lightning
pickups to load a different prank on the same dash button. The teal hoodie is you.

The square now includes thirteen varied buildings and eleven pieces of street
furniture around the original stalls. Seven grumpy personalities have dashable
props: bell, flowers, queue barrier, vacuum, statue, laundry and squeaky toy.
Three larger incidents share one bounded spectacle slot: barbecue fire, a giant
poop bomb and the café inspector's disastrous free sample.

## Try it

```sh
npm ci
npm --workspace grumpy-town run dev
```

Open Vite's Network URL on a phone on the same Wi-Fi. No account, API or game
server is needed. For the smaller production bundle:

```sh
npm --workspace grumpy-town run build
npm --workspace grumpy-town exec vite preview -- --host 0.0.0.0 --port 5183 --strictPort
```

- Touch: floating joystick + **DASH + DROP**. Pinch the street or use +/− to zoom.
- Keyboard/mouse: WASD or arrows, Space to dash, scroll or +/− to zoom.
- Pause offers resume and reset. Backgrounding pauses; returning requires resume.
- Dash lasts 0.2 seconds, drops one 2.4-second cloud and has a 3-second cooldown.
  Ice, fallen fruit and cartoon puke reduce traction; release the joystick to
  feel the remaining momentum. Powder causes 3.2 seconds of dizziness and a puke
  puddle. A mini-zap shrinks its target for 6 seconds; it never removes control.
- Owners telegraph a zap at a fixed ground target for 0.85 seconds. Move away to
  dodge a three-point penalty. Busy owners prioritize cleanup before watching
  again. Six fresh rewarded incidents give **+50**, then a five-second warning
  precedes **ten police departing from the Ministry of No Fun** for 25 seconds.
  They stop attacking and return home at shift end, followed by a quiet cooldown. Stay near a frozen friend for one second to rescue; auto-thaw
  happens after six seconds. Raids do not deduct points.
- A newly damaged object gives 10 points and one trouble mark. Each source has
  a 30-second reward cooldown; empty dashes do not count. Provoked animal attacks
  hitting residents/police also earn credit; unprovoked accidents do not.
- Poop, pee and puke stain characters temporarily. Water washes them off. Animal
  attacks show a locked warning target for one second; move away to dodge.
- Powder and zapper pickups are outside the purple and yellow stalls down the
  street. One pickup equips one dash; stocked counters replenish pickups after
  10 seconds. The HUD and action button show the loaded prank.

- Kick **DO NOT KICK** beside the café to earn +20 and dispatch two firefighters.
  They warn, hose the barbecue, wash/push anyone in the stream, then return to the
  truck. Nearby witnesses can pursue; walls protect your identity.
- Walk south to **THE BIG STINK**, then dash to drop the bomb. Its two-second
  warning marks a six-unit radius. Cover blocks the splash; twelve or fewer
  temporary patches leave escape gaps. The pickup replenishes after 45 seconds.
- Dash **FREE SAMPLES** at the café. The inspector warns for two seconds, sprays
  for six, then the waiter cleans with an absurdly small bucket. Dash the umbrella
  to deflect the stream while the waiter protects the cake. Fire and café sources
  have 45-second cooldowns; each incident gives +20 and one trouble mark.
- Ordinary personality pranks give +10 once per 30 seconds. Watch the gardener
  chase a wig, residents argue, the vacuum burp, laundry fly and animals steal
  personal belongings. Ambient routines do not award points.

The portrait joystick is 100 CSS pixels and action button 84, floating within the
bottom quarter at the tested 390 × 844 viewport. Landscape uses 80/76 pixels.
Zoom buttons are at least 44 × 44. Camera width is bounded to 8–24 world units in
portrait and scaled by aspect in landscape. The default width is 13. The walkable town is now 48 × 48 world
units with six interactive shops, five street objects, fountain/cart, six
creatures, eight additional residents, civic/shop/house facades and street furniture; the camera follows through the streets.

## Production deployment

[Play Grumpy Town](https://grumpy-town.intact-software-systems.workers.dev). Cloudflare serves the static app and handles navigation to `/guest`. The standard Rallar API on Hetzner handles sign-in, guest invitations, presence and signaling. A player hosts each match.

From the repository root, build for the public API and deploy the assets using the Cloudflare CLI.

```sh
cd apps/grumpy-town
VITE_RALLAR_API_BASE_URL=https://api.rallar.intactss.com npm run build
cf deploy ./dist
```

Verify a release by opening an invitation in a separate browser session, readying both players, and confirming each sees the other move after the host starts the round.

## Optional online lobby

The Rallar application ID is `grumpy-town`. When switching from the prototype build, reload all devices and create a fresh town and invitation.

To host, choose **Play with friends**, sign in and **Create town**. Choose
**Invite guests** to show a QR code and a shareable link. A friend can scan or
open the link, shuffle their nickname and tap **Join this town** without an
account. Reloading in the same tab restores their seat. **Replace invitation**
issues a new link. **Remove guest** ends that guest's access and cancels the
current link.

Solo runs without Rallar. To run multiplayer locally, start the standard
Rallar API alongside the app.

```sh
npm --workspace grumpy-town run start:rallar
npm --workspace grumpy-town run dev
```

The launcher runs the existing Rallar API on port 8084 with an isolated in-memory
store and fresh process-only secrets. Accounts, rooms and friendships disappear
when that server stops. The browser uses the app's origin by default. Vite
proxies its API requests and WebSocket connections to Rallar. Set
`VITE_RALLAR_API_BASE_URL` to use a different API origin.
`GRUMPY_TOWN_RALLAR_PUBLIC_URL` configures the API's advertised public HTTP/WS origin and
`GRUMPY_TOWN_RALLAR_PORT` selects its listening port. These origins must agree; never
weaken Rallar's WebSocket host validation to work around a mismatch.

The online lobby supports account registration/login, private-by-discovery open
rooms (anyone with their code may join), two-sided friend requests, visibility,
blocking and room invitations. Matchmaking requires both players to confirm,
then explicitly enter their matched town. In the town lobby, the owner chooses
**Host match**, everyone chooses **Ready** after the town finishes preparing, and
the director chooses **Start round**.
The shared town uses the same movement, dash/drop and zoom controls. The three-minute
round targets 100 individual points and permits several qualifiers. Online players
are real human sessions; BOT PAL remains only in solo.
Ready submits your username for the round's player labels. The host associates it
with your authenticated seat and retains it through results. The current match build is `grumpy-town-v7`. If players have different versions,
refresh Grumpy Town on every device before starting a round.
Leaving hands ownership to another active member, or closes the town when its
last member leaves. Lost action replies expose a retry button. Returning to solo
opens the playground immediately while the online session finishes cancelling
its search; online re-entry waits for that cleanup. If the network stays unavailable,
cancellation cannot be confirmed and the search status must be checked after reconnecting.
Live movement uses Rallar's unordered RTC realtime room channel first, with
WebSocket delivery to peers whose RTC channel cannot accept the frame. Controls
and compact host poses are published at up to 20 Hz; poses do not wait for
checkpoint acknowledgements. The host still decides all gameplay. Scores, town
interactions, results and recovery remain on acknowledged WS checkpoints.
Receiver checks bind every frame to the full room, current host epoch, match and
session. Pose sequences/ticks cannot rewind; stale poses expire after 250 ms.
Local prediction now uses live host movement/dash state as its base, with a 300 ms
lead limit. Missing live poses retain the last newer movement base without renewing
that limit or falling back to an older checkpoint. Small corrections blend through
collision constraints; freezes, recovery and authority changes reset immediately.
Dash shows its cooldown and requires both predicted and observed host readiness.
Player hoodie colors come from the shared retained participant order, so the local
and remote views agree. The YOU label identifies your assigned hoodie; colors
persist through reconnects and host changes within the same round.
The smoother 150 ms remote presentation buffer is retained after the shorter-buffer
phone trial proved jittery. Network transport and confirmed outcomes are separate
from visual prediction. DOM diagnostics expose `data-pose-transport`,
`data-live-send`, `data-input-transport` (last authenticated input carrier) and
`data-pose-tick`; successful dash effects use `data-pranks` / `data-render-pranks`,
while the older dash diagnostics count consumed attempts. These are developer
observations, not new gameplay controls.

The healthy shared-match flow and temporary checkpoint-loss pause/resume are implemented.
If confirmation stops for 4.5 seconds, the game pauses while retrying checkpoints.
Movement and dash pressed during that pause are discarded. With three players, closing
the host can appoint an eligible survivor and continue the same confirmed round with
a backup. Losing either member of a two-player match pauses play. It interrupts after at most
14.5 seconds without a confirmed checkpoint. Confirmed points remain visible and every player can
leave. After agreement returns, the director can open a fresh ready cycle.
A newcomer during play interrupts the round. In a continuing three-player round,
an original player can close and reopen their browser and rejoin within a ten-second
seat grace period. A later return, or an explicit departure, watches until the next
round with confirmed points preserved. The other two sessions agree on recovery;
the returning browser must acknowledge the new state before confirmation resumes.
The same page also retains the paused scene after an observed socket disconnect.
Restoring access before grace expires returns control; a later return watches
the continuing round. Transport backoff can delay that return beyond seat grace;
one expired-return trace took about twenty-one seconds after access was restored.
Input pressed during disconnection is discarded. During recovery and on the
interruption screen, **Back to solo** opens local play immediately while online
cleanup settles separately; it does not claim server-confirmed departure.
Checkpoint recovery distinguishes a returning follower, which must catch up past
abandoned proposals, from a briefly disconnected host, which must retransmit its
exact outstanding proposal while its appointment and roster remain unchanged.
Silent host connection loss and suspended host JavaScript now produce a shared
interrupted outcome after the recovery deadline, including when the host resumes.
An old host can return as an observer after two survivors appoint a replacement;
it cannot preempt the current host merely because its local heartbeat is stale.
Real two-account browser trials now cover shared fruit/cleanup, a full three-minute
round and rematch, human rescue before auto-release, and two named 110-point winners.
Normal-clock browser trials also verify silent-outage takeover and old-host
return without a socket-close callback. Physical backgrounding and device
qualification remain in [the multiplayer plan](../../projects/grumpy-town/rallar-multiplayer.md).
Remaining cross-clock integration is deferred to
[issue #836](https://github.com/intact-software-systems/ar-eye-hunter/issues/836);
the trial does not claim fully clock-skew-safe multiplayer.

`npm --workspace grumpy-town run test:browser` starts local Rallar when needed and tests
real independent accounts alongside the solo controls. The HTTPS phone setup
below has a verified certificate chain and live game/API origin. Each physical
phone still needs to trust that certificate; localhost testing is not evidence
of phone WebCrypto support over LAN HTTP.

Online entry checks for a secure context and the required browser crypto APIs
before loading Rallar. An unsupported connection or browser shows an explanation
and a **Back to solo** link instead of a `crypto.randomUUID.bind` startup crash.
The phone trial uses HTTPS on **5184**; an older HTTP preview on **5183** can run
solo but cannot supply the secure browser features multiplayer requires.

### HTTPS phone trial

Use a certificate valid for the computer's LAN address and trusted by each device.
`GRUMPY_TOWN_TLS_CERT` and `GRUMPY_TOWN_TLS_KEY` enable Vite HTTPS; setting only one fails startup.
Keep private keys outside the repository and the web root. The API and WebSocket
must advertise the same HTTPS origin the phone opens. Vite forwards `/api` and
WebSocket requests to the local Rallar process; no additional game backend is used.

For example, with certificates in `/private/tmp/grumpy-town-phone-tls` and the computer at
`192.168.1.247`, run these in two terminals from the repository root:

```sh
GRUMPY_TOWN_RALLAR_PORT=8085 GRUMPY_TOWN_RALLAR_PUBLIC_URL=https://192.168.1.247:5184 \
  npm --workspace grumpy-town run start:rallar
```

```sh
GRUMPY_TOWN_TLS_CERT=/private/tmp/grumpy-town-phone-tls/server.crt \
GRUMPY_TOWN_TLS_KEY=/private/tmp/grumpy-town-phone-tls/server.key \
GRUMPY_TOWN_RALLAR_PROXY_TARGET=http://127.0.0.1:8085 \
VITE_RALLAR_API_BASE_URL=https://192.168.1.247:5184 \
  npm --workspace grumpy-town run dev -- --port 5184
```

Open `https://192.168.1.247:5184` on the same Wi-Fi. Replace the address and
certificate together if the computer's LAN address changes. These separate ports
preserve an existing localhost trial on 5180/8084. The new API has its own temporary
accounts; its data is lost when it stops.

For a locally issued certificate, transfer only the public CA certificate to the
phone. After installing it, enable that CA under **Settings → General → About →
Certificate Trust Settings**, following [Apple's instructions](https://support.apple.com/en-us/102390).
Remove the trial certificate profile when finished. Browser automation with
certificate errors ignored verifies app flows but does not prove device trust or
physical Safari behavior. The development server's HTTPS/proxy options follow
[Vite's server configuration](https://vite.dev/config/server-options.html#server-https).

## Construction and owners

- `main.ts`: lazy solo/online entry and page lifetime.
- `online/online-session.ts`: optional Rallar account, room, social and matchmaking lifetime.
- `online/online-lobby.ts`: responsive account and lobby DOM; `online-panels.ts` renders their projections.
- `online/online-match.ts`: current-room match lifetime, ready/start controls and gameplay mount.
- `match/match-room.ts`: current room sessions, authority relay, bounded refresh and eligible appointment.
- `match/match-session.ts`: authenticated room traffic, checkpoint exchange and recovery lifecycle.
- `match/match-transport.ts`: RTC-first live frames, missing-recipient WS fallback and subscriptions; agreement remains WS.
- `match/match-live-poses.ts`: bounded latest host pose observation, independent of confirmed state.
- `match/match-peer-presentation.ts`: Rallar Motion interpolation and collision-constrained remote poses.
- `match/match-presentation.ts`: bounded local movement/dash prediction.
- `match/match-simulation.ts`: director clock, expiring inputs and speculative canonical town state.
- `match/match-seats.ts`: confirmed controller seats, absolute grace deadlines and observer eligibility.
- `match/match-game.ts`: confirmed world/timer/results, live human poses and input lifecycle.
- `match/match-checkpoints.ts`, `match-protocol.ts`, `match-snapshot.ts`: agreement and exact wire validation.
- `practice-app.ts`: fixed 60 Hz simulation loop, HUD, pause/reset and teardown.
- `practice-controls.ts`: keyboard, independent pointer capture and pinch input.
- `practice-rules.ts`: independent player movement, dash, traction, cloud lifetime and collision; solo composes this with one town tick.
- `town/rules.ts`: tick coordination for owners, props, raids, effects and rescue.
- `town/state.ts` and `town/map.ts`: canonical state and map geometry.
- `town/owners.ts`, `town/authorities.ts`, `town/companion.ts`: duties, pursuit, catch and rescue.
- `town/mess.ts`, `town/props.ts`, `town/objects.ts`, `town/pranks.ts`: bounded interactions and cleanup.
- `town/creatures/`: creature rules, original cutout art and rendering.
- `town/layout/`: varied solid buildings, street furniture and their cutout facades.
- `town/personalities/`: petty rules, reactions, rivalries and resident hose.
- `town/spectacles/`: queued fire, bomb and café incidents, crew and rendering.
- `town/soiling.ts`: stains, washing and mess immunity.
- `town/mischief.ts` and `town/raid.ts`: rewards, trouble and police wave lifecycle.
- `town/navigation.ts` and `town/routes.ts`: collision, sight and obstacle-aware travel.
- `town/*presentation.ts`: visual state; it never decides game outcomes.
- `practice-scene.ts`: Babylon engine, camera, actors and cloud presentation.
- `cutout-actor.ts`: ground anchor and hinged limbs; visual poses never move rules.
- `cutout-art.ts`: original SVG part textures, paper grain, shared unlit materials.
- `create-market-environment.ts`: simple textured geometry and ground patches.

The renderer uses WebGL, capped render density, alpha-tested cutouts and a blended
blob shadow. No physics package, external font, generated runtime bitmap download,
CDN script or image API is required. Scene disposal releases Babylon resources;
input listeners belong to abortable lifetimes. Context loss shows a reopen link.

This entry replaces the earlier Phaser practice. That entry's collection,
banking and online UI are removed from this trial. The local chase/freeze/rescue slice is implemented with a labelled bot companion.
The optional Rallar player-hosted match now runs alongside solo, with normal-clock
host recovery verified through real browser trials. Physical-phone qualification
and the deferred clock work remain outside the completed local-trial scope.

## Checks and evidence

```sh
npx vitest run packages/tests/grumpy-town
npx playwright test --config apps/grumpy-town/playwright.config.ts
npm --workspace grumpy-town run build
```

The browser suite covers visible controls, simultaneous touch movement/action,
pinch zoom, desktop movement, responsive layouts, pause/reset and keyboard button
activation, stall damage/cleanup, powder pickup, fountain/cart interactions and
a full bonus/ten-police/freeze/recovery/return cycle, plus bomb warning/reset, fire dispatch/return and the finite café spectacle. It uses an isolated Chromium context and port 5182.

See [gameplay trial results and limits](../../projects/grumpy-town/babylon-local-trial.md).
Physical iPhone/iPad comfort, Safari behavior and sustained frame pacing still
need testing on devices. The solo scene remains a visual/feel trial; the optional
match still needs the remaining reliability and device qualification in the multiplayer plan.
