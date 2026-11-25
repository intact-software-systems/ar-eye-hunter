# Babylon local cutout trial

Implemented 15 November 2026 in [the SPA](../../apps/grumpy-town/README.md), using pinned
Babylon.js 9.36.0. The local trial now includes the
[Grumpy Town interaction slice](grumpy-town.md) before multiplayer. Working scene
title: **Grumpy Town**. The sections below the physical-device report preserve
the original solo trial; their original limitations do not describe the later
multiplayer implementation.

## Local movement and Dash after RTC — 16 November 2026

The physical v5 trial confirmed RTC controls and live sends in Alice's browser.
The user reported **"remote it looks alright, but locally it is jittery and jumpy"**,
then **"local Dash button is often unresponsive"**. Remote smoothing stays at
150 ms; the next correction targets local prediction and dash readiness.

**Confirmed mechanism:** local prediction still used committed checkpoints and
stopped after 300 ms of simulation lead. The live sample's host pose was 25 ticks
(~830 ms) ahead of its checkpoint. This is simulation-state lead, not a network
latency measurement. A separate Chromium trial at 390×844 delayed each incoming
checkpoint proposal/commit by 200 ms while RTC continued. Over 713.5 ms the old
local display advanced 0.806 units, moved in 8 of 23 sampled frames, stepped
backwards by up to 0.081 units, and still showed consumed Dash count zero at the
immediate post-tap observation. The initial all-checkpoint-drop harness entered
recovery and was replaced by this continuing-delivery workload.

Local prediction now uses fresh host movement/dash state; scores, shared world
and recovery still use checkpoints. Small positional corrections blend through
collision constraints. When a live observation expires, an older checkpoint
cannot rewind the retained movement base or renew its 300 ms budget. Canonical
freezes, recovery, round and authority changes reset prediction. Wire build
**grumpy-town-v6** adds bounded dash/cooldown/cloud state and requires both clients
to reload. No Rallar package code changes are needed.

Dash shows a countdown, then becomes available when both prediction and the
latest admitted host state say cooldown is over. This avoids advertising readiness
before the host can accept the tap. Consumed input counters alone do not prove a
dash succeeded; the regression also verifies the host's successful prank count.

Two initial corrected Chromium trials advanced 2.555 and 2.512 units over 710.2
and 706.5 ms, with movement in all 18 frame-to-frame intervals and no backward
steps. Both showed the local dash immediately. These small samples establish
continuity in this workload, not physical iPhone performance. The final validation
includes the subsequent expiry/cooldown review fixes: final repeated runs advanced
2.585/2.566 units over 718.9/698.9 ms, every sampled interval moved forward
(22/22 and 21/21), with no backward step. Both first and immediately-after-ready
second dashes were confirmed by successful prank counts.

After reloading v6, Bob's iPhone feedback was **"it looks a lot better. It feels
responsive and the way a game should feel like."** Alice's browser showed an active
two-player round with 104 seconds remaining when that feedback was checked. This
accepts movement/Dash feel for this physical trial; it is not a measured phone
latency or a broad device/network qualification.
Artifacts are ignored under `tmp/perf/grumpy-town-local-before`, `grumpy-town-local-after` and
`grumpy-town-clean-local-control`.

Final clean-candidate validation passed 180 game/Motion tests, Grumpy Town typecheck/build,
focused test compilation and eight browser checks: local continuity twice, native
RTC/WS fallback, remote/local response, host-loss recovery, and the complete fruit
round with matching results/rematch. Deferred AL edits were excluded and restored
with hash verification. Full changed-file and recursive support review found no
remaining issue; independent untouched code remained outside closure. No new
follow-up issue was created. The phone trial then identified a separate appearance
bug: each client colored itself teal and assigned remote colors by local insertion
order. Colors now follow the shared retained participant roster on both screens;
the torso, sleeves and local YOU label update together. Reconnect/host changes
within the same round preserve those assignments. The subsequent phone color
check was accepted: **"I am playing now and it looks good."** Keep the current
movement, Dash and appearance settings. The color correction passed the Grumpy Town build/final typecheck and a real
two-account browser test. Both screenshots were inspected: the same left player
is teal and the same right player copper, with the correct local ground marker
and YOU hint. Captures are under ignored `tmp/perf/grumpy-town-player-colors`. Full-file
review included actor material caching/disposal and the recursively affected scene
and renderer; independent untouched code stayed outside closure.

During that check, Alice also showed two-second state-heartbeat timeouts,
then a connection pause and an interrupted round with 91 seconds remaining.
The preserved result showed Alice 0 / Bob 34. Re-entering through solo restored
Alice's connection, but she was no longer host. The user's subsequent positive
play report does not establish the interruption's cause or resolution. Next:
reproduce that interruption with foreground/lifecycle and connection evidence,
then investigate the separately reported stale lobby roster. No game server was
restarted and no broad clock fix is claimed.

## Phone retest and remote-player smoothing — 16 November 2026

The user reported **"locally no lag, but remote player looks laggy"** after the
local-prediction correction. Alice hosted on the desktop and Bob played on the
iPhone; the round completed with Alice 0 and Bob 40 in Alice's result view.
This is positive subjective feedback for local controls, not a measured iPhone
latency or confirmation of the phone's final result display.

A live 5.360-second observation of Alice's view recorded 37 checkpoint states
and 35 changes in Bob's position. The median checkpoint gap was 122 ms and the
largest was 272 ms. These DOM observations confirm uneven received presentation
updates; they do not measure transport latency or phone frame rate. The raw
sample is retained locally under `tmp/perf/grumpy-town-peer-before.json`.

In the initial checkpoint-only revision, remote actors used the existing
**Rallar Motion buffer** through an app-owned peer presentation adapter. It interpolated with a 150 ms buffer and can extend
the latest confirmed velocity by at most 100 ms. After that it holds the endpoint,
rather than moving indefinitely or snapping back to the old snapshot when the
extrapolation window expires. The app's existing obstacle rules constrain the
pose. Confirmed freezes, recovery, round/authority changes, large discontinuities
and suspended rendering discard old pose history immediately. Face/status effects
used confirmed player state; animation time and displayed position could advance
between checkpoints. That initial revision changed neither package implementation
nor message format. The current RTC revision below uses live velocity for facing
and introduces the v5 match wire format.

**Tradeoff:** buffering smooths the remote player's movement at the cost of some
additional presentation delay. It does not make remote actions arrive earlier.
The local player's immediate response is unaffected. Long delivery gaps and sharp
direction changes may still require a visible correction. The user subsequently
confirmed that movement was smooth but reacted late after reloading this version;
the delay adjustment below follows that feedback.

The browser regression drives one player through visible controls and samples
the other view each animation frame, recording both confirmed and rendered peer
positions. It requires more than twice as many rendered changes as confirmed
changes during steady movement. This compares both paths within one workload;
it is not a comparison between the physical-phone trial and a desktop benchmark.
Artifacts are under ignored `tmp/perf/grumpy-town-clean-peer-presentation/`.

Two clean-candidate Chromium runs at 390 × 844 measured 52 and 56 rendered peer
position changes versus five and seven confirmed changes over 1.505 and 1.535
seconds respectively. This establishes intermediate motion in that workload,
not a phone frame-rate guarantee. All 169 game/Motion tests, the app build and
five browser checks passed (peer/local-response checks repeated twice, plus silent
host-loss recovery). The existing 15-second unit-test budget was retained for the
long town simulation. Deferred AL-builder edits were excluded and restored with
hash verification. Review covered all changed files; no shared Motion code was
modified. That initial version was smooth on the phone but its response delay was not accepted.

### Rejected shorter peer display delay

After the user reported **"Moves smoothly, but reacts late"** and confirmed it
was after reloading the new smoothing update, the display buffer was reduced
from 150 ms to **50 ms**. Extrapolation remains capped at 100 ms; its hold endpoint
is derived from both limits so changing the buffer cannot accidentally extend
prediction. A received stop settles at its confirmed position within 50 ms.
No checkpoint acknowledgement, exchange cadence, wire format, scoring, recovery
or shared Rallar implementation changes in this adjustment.

Two comparative Chromium runs measured median **observed checkpoint-to-displayed-position delay** of 157.7 / 165.2 ms before and 55.0 / 57.7 ms after. The test starts
at the confirmed position exposed by the render loop and ends when the displayed
peer reaches that position. It does not measure socket receipt, remote input or
network latency. Medians include positions reached within the 1.5-second sample
window, so the incomplete tail is excluded. Both before/after runs used the same
working-tree state, including the separately deferred AL edits. Artifacts are
under ignored `tmp/perf/grumpy-town-peer-delay-before` and `grumpy-town-peer-delay-after`.
The shorter-buffer runs retained 42 / 50 visible changes versus 6 / 7 checkpoint
changes. These are small desktop Chromium samples, not iPhone guarantees.

Lower delay spends more time extrapolating between sparse checkpoints, so sharp
reversals can require more correction and longer gaps can reach the hold limit.
This adjustment removes deliberate display delay; checkpoint agreement and
transport delay still precede it. The physical-phone retest rejected this balance:
the user reported **"It feels worse then the previous round. It is jittery"**.
The app restores the earlier **150 ms interpolation / 100 ms extrapolation**
configuration. The lower median delay and extra rendered frames were insufficient
acceptance metrics: neither proves smooth direction changes or correction quality
on the phone. The trial measurements remain historical evidence, not a successful
optimization. The 50 ms-specific assertions are removed with the rejected policy.

The clean candidate separately passed all 170 game/Motion tests, the app
production build and four real-service browser checks (peer delay/smoothness and
local movement/dash, each repeated twice). Deferred clock edits were excluded
and restored with hash verification. These checks and artifacts are retained under
ignored `tmp/perf/grumpy-town-clean-peer-delay`. Full-file review found no remaining
issue in the adapter or tests; no shared package code changed.

### RTC-first movement with WebSocket fallback

The user requested RTC and explicitly allowed WS when RTC is unavailable. Grumpy Town
now sends controls and compact host poses through Rallar's existing room realtime
channel at up to 20 Hz. A peer missing an accepted RTC send receives the same
sequenced frame over WS. Closing a native realtime channel switches that peer to
WS; agreement, points, shared world state, results and recovery remain on the
existing WS checkpoint path. No Rallar package implementation change was needed.

Fresh authenticated host poses feed the remote presentation buffer before
checkpoint agreement. The smoother 150 ms buffer / 100 ms extrapolation policy
is restored. Poses expire after 250 ms, obey match/room/host-epoch checks, reject
out-of-order frames and cannot release a confirmed freeze or change scores.
Facing follows live velocity; status effects remain confirmed. Protocol
**grumpy-town-v5** requires both players to reload before the next trial.

Real-browser tests observe native RTCDataChannel messages, verify that guest
input changes the host state, and move the remote actor while new WS checkpoint
proposals/commits are withheld. Separate blocked-RTC and mid-round channel-close
cases verify WS movement and dash. Four runs of these two scenarios passed,
plus both local-response and remote-presentation checks. The game/Motion suite
passed 178 tests; the Rallar room realtime runtime passed nine tests separately.
The app production build and focused changed-test typecheck passed. These are
Chromium observations at phone viewport size, not physical iPhone acceptance.

The first recovery run failed before the partition while the lobby showed 2/3
ready and heartbeat timeouts; its immediate restart hit test-port contention.
A fresh run passed host-loss takeover, old-host fencing/return and resumed input.
This does not establish the cause or resolution of the separate stale-roster
observation. The uninterrupted full fruit-prank round also passed shared cleanup,
matching results and a clean rematch on this RTC candidate. The second full round
passed human rescue and two qualifying winners with matching results. All nine
final browser checks passed across the transport, response, recovery and full-round
runs. Deferred AL changes were excluded and restored with hash verification.
Final formatting corrected three restored files; no gameplay behavior changed.
Full-file and recursive support review found no blocker or retained affected legacy.

### Foreground heartbeat and stale lobby investigation — 18 November 2026

In the iPhone trial Bob saw the expected room code while Alice saw only herself
ready. A browser trial also observed the host showing 1/1 and the guest 1/2.
A three-account regression isolated one way Ready could disappear. While a
guest's Ready message was withheld, another player joined. Restoring delivery
left the old implementation at 0/3. The guest now retries their pending choice
within the same signed-in session, appointment epoch and lobby match. The host
then confirms 1/3. A successful room recovery also clears the transient refresh
error so the lobby can display the confirmed state again.

An idle two-browser lobby sent 1,839,309 bytes in 266 WebSocket frames in a
five-second sample. The host now reuses its confirmed checkpoint and replays
it once a second so a guest can catch up. The comparison sample sent 124,665
bytes in 20 frames. Pending changes still use the 100 ms exchange interval.
These measurements concern lobby traffic. Running-round movement still uses
RTC with per-peer WebSocket fallback.

Two consecutive injected heartbeat timeouts alone did not interrupt an established
foreground pair. Under concurrent browser load, timeouts and a countdown
interruption also occurred before fault injection. One two-browser trace isolated an interruption after both players confirmed the
countdown. Only the host briefly observed the guest missing from the roster.
Both pages stayed visible and both sessions returned in the same appointment
epoch. The host then waited for a recovery report while the guest continued
sending ordinary checkpoint acknowledgements. After eight seconds of restored
membership the round still interrupted.

A controlled repeat held both sockets open and varied only the host's roster
observation. Confirmed ticks stopped advancing in both baseline runs. A stalled
guest now offers its last locally committed checkpoint as recovery evidence.
The host still checks the sender, epoch, roster and checkpoint digest. Three
consecutive browser trials resumed progress after restoring the host's view.
The original iPhone interruption still needs a physical-device retest.

### Next two useful slices

1. Repeat Ready, guest reload and round start on Bob's iPhone and Alice's
   browser. Compare both rosters before starting and after returning to the lobby.
2. Repeat a round across a brief connection interruption with both pages in
   the foreground. Record checkpoint progress, lease freshness and visibility
   if either device stalls or shows an interrupted round.

## Responsiveness correction — 16 November 2026

The online renderer now predicts the local player's movement and dash using the
same movement, slipping and obstacle rules as the host. It keeps at most 300 ms
of visual lead over the latest confirmed player state, rebases on each new
checkpoint and replays only the newer local presentation interval. This interval
is aligned by simulation elapsed time, not by subtracting device wall clocks.
It is a visual estimate, not an input acknowledgement. During a long delay it
stops advancing rather than inventing a continuing match.

The town, interactions, points and results still come from
confirmed checkpoints. A local dash/cloud may be corrected if the host rejects
it. A confirmed freeze cannot be released by prediction. Recovery, observer
mode, new rounds and authority changes discard the prediction; round-end
transitions render the confirmed final pose. No wire format, checkpoint frequency,
acknowledgement requirement or Rallar package behavior changes in this correction.

**Host match** now follows Rallar's existing appointment eligibility policy and
is disabled while appointment is pending. Manual and automatic appointments share
one error lifecycle: a fresh host clears an obsolete appointment failure, while
unrelated transport/validation failures remain visible. Browser coverage includes
a guest failing to host while the owner is absent, followed by the returning owner
hosting successfully and the guest receiving a healthy Ready/status display.
Creating a new town also cancels the previous room-entry destination and failure;
a refused old matched-town entry must not remain as an error over a successful
new lobby. This additional issue was reproduced while preparing the phone retest.

### Response measurement

The browser test records `performance.now()` at the actual key/pointer event,
then observes the rendered player and the confirmed player each animation frame.
The confirmed-state timing represents the old renderer's wait in the same trial;
it is not a separate measurement of an old executable. Movement is measured from
rest and dash by its action counter, avoiding the earlier sliding/click-tool
timing ambiguity. Diagnostics for confirmed state remain separate from rendered
state. Raw run artifacts are under ignored `tmp/perf/grumpy-town-clean-responsiveness/`.

Two clean-candidate desktop Chromium trials, each with a host and guest, recorded:

| Event-to-observed-state metric | Confirmed state (old display path) | Local presentation | Samples |
| --- | ---: | ---: | ---: |
| Movement median | 364.5 ms | 3.6 ms | 4 |
| Dash median | 417.0 ms | 6.0 ms | 4 |

Movement presentation ranged from 3.4–45.1 ms; dash presentation ranged from
5.8–6.3 ms. This confirms removal of the checkpoint wait from the local visual
path in this small desktop workload, not a general latency guarantee. The tests
used real local Rallar services, normal device clocks and Chromium's software
WebGL configuration. Deferred AL-builder edits were excluded and then restored.
CPU/GPU, allocation and physical display-scanout costs were not profiled.

Final validation is recorded in PR #832. These tests do not establish touch
latency or sustained frame pacing on a physical iPhone. The first measurement
harness missed an event before its listener was
armed; it now waits for listener readiness. A later run was invalidated by a
development-server reload during editing and was discarded.

The publishable candidate passed 138 game tests, the app typecheck/production
build, and nine real-service browser checks: the three new scenarios repeated
twice, independent two-player controls, silent host-loss recovery, and the real
three-minute fruit-prank round with shared results and a clean rematch. The unit
command used `--testTimeout=15000` because the existing long police-wave simulation
exceeded its five-second budget; assertions and simulated duration were unchanged.
Build chunk-size warnings remain. Independent review covered every changed code
and test file; no remaining correctness blocker or retained legacy exception was
identified. Physical-phone acceptance is still pending.

### Follow-up selected after the local correction

1. Retest the HTTPS build on Bob's iPhone with Alice in the desktop browser.
   Compare immediate movement, releasing movement, dash, sliding and corrections
   near stalls; finish a round and rematch. Compare phone-host and desktop-host
   behavior if lag remains. Record phone model/browser and local render cadence.
2. Use that feedback to tune correction behavior and peer presentation. Peer
   interpolation is now implemented above; snapshot/serialization profiling remains follow-up work;
   do not change authoritative scoring or weaken recovery to hide a visual delay.

The original physical trial below describes the committed-only renderer before
this correction. The PR remains draft until phone responsiveness is accepted.

## Physical two-player trial — 16 November 2026

Tested the HTTPS LAN build on port 5184 at revision `74e87470b`, with Bob hosting
on a physical iPhone and Alice joining through the Codex in-app browser on the
development computer. The phone's exact model, iOS version and render frame rate
were not captured. Deferred AL-builder edits were present in the local working
tree; this is local device evidence, not qualification of the clean PR revision.

**Functional result:** the full three-minute round completed without an observed
disconnect. Alice received Bob's movement, sent her own keyboard movement and
three accepted dashes, zoomed, and earned points. Alice's result screen showed
Bob at 120 points (winner) and Alice at 60. The user confirmed the phone reached
the end and restarted, but missed its exact scores. A new match ID and a running
second round were observed on Alice, confirming rematch propagation. That round
also completed: Alice's screen showed Bob at 157 points and Alice at 57, and the
user confirmed those numbers on the phone. The user also confirmed both players
were visible on the phone. Alice's browser reported
no captured console warnings or errors at the end; the earlier appointment
rejection was rendered in the lobby rather than logged to the console.

**Responsiveness result: not accepted.** The user reported movement or dash lag
on the iPhone. Receiving state and finishing a round do not establish a good
game experience.

### Measurements and limits

Read-only sampling of Alice's rendered DOM diagnostics during the rematch
recorded 150 observations over 4.988 seconds. The simulation advanced 146 ticks
(about 29.3 ticks/second). There were 31 observed state changes; the 30 intervals
between them had a median gap of 122 ms and a maximum gap of 244 ms. The initial
sample-to-first-change wait was 306 ms and is excluded from those intervals.
Browser reads took a median 21 ms, with
10 ms requested between reads; this samples visible update cadence, not the
phone's frame rate or raw network latency. An earlier 5.845-second sample showed
176 ticks of simulation progress, providing a second near-30-Hz observation.

Three further dash presses were accepted. Their automated action-to-observation
times were 271–372 ms, but the click tool itself occupied about 268 ms, so those
values cannot establish actual touch latency. Short alternating movement probes
were also inconclusive because residual sliding could move the character before
the newly requested direction took effect. Do not quote either as a measured
phone input latency.

Raw local observations are under ignored `tmp/perf/grumpy-town-iphone-host-*.json`.
The first finer-cadence attempt ran after the round finished and is not a
gameplay performance sample. No CPU/GPU profile, allocation measurement or
phone touch-to-frame measurement was collected.

### Original diagnosis and proposed slices

**Proven from the trial revision's code:** `TownMatchSession.advance` samples controls at 50 ms and
exchanges checkpoints at 100 ms. `TownMatchSession.getView` exposes committed
checkpoint state, and `TownMatchGame.frame` renders that state for the local
player as well as peers. Even the phone host waits for checkpoint confirmation
before displaying its simulated movement. This adds confirmation delay to the
visible control path. The observation of near-30-Hz simulation with substantially
less frequent displayed state supports investigating this path first; it does
not rule out phone rendering cost or network scheduling.

1. Measure input sampling, host acceptance, checkpoint confirmation and visible
   presentation separately using monotonic clocks on each device. Capture phone
   render cadence and snapshot payload/serialization cost. Compare phone-host
   and desktop-host runs, plus offline solo, without subtracting unsynchronized
   device clocks. Preserve the current completed-round baseline and recovery
   tests. A smoother solo run alone does not identify the exact multiplayer cost.
2. Based on that trace, make the smallest presentation change that removes
   confirmed input delay: assess local movement prediction/reconciliation and
   peer interpolation, while keeping points, hits, hazards, winners and recovery
   checkpoints authoritative. Do not merely increase full-checkpoint traffic or
   weaken acknowledgments. Require measured before/after response, a full round,
   rematch and host-loss regression checks before accepting the change.

The trial also exposed a lobby issue: a non-owner was offered **Host match** while
an owner was online. Rallar correctly rejected it, but the raw rejection remained
visible after the owner hosted and Ready succeeded. The correction above uses the
existing director-appointment eligibility policy and clears superseded appointment
errors. No Rallar authorization policy change was needed.

## Browser trial conditions

The expanded town was exercised in Chromium at 390 × 844 CSS pixels with the
visible joystick and simultaneous Dash input. The trial covered the Big Stink
warning and splash, fire and cleanup, café and umbrella reactions, the tiny
bucket and the bell. The renderer capped density at 1.5.

## What to try on your phone

Run the commands in the app README and open its Network URL on the same Wi-Fi.
A local HTTP URL is sufficient for this offline WebGL trial. Later authenticated
Rallar testing uses the architecture's HTTPS deployment.

1. Dash into fruit. Its owner cleans while a tidy neighbour may chase. Dodge the
   marked zap or lose three points. Walking alone does not upset anyone.
2. Dash into the central fountain to redirect its jet. Try escaping through the
   spray while the apple owner repairs it. Release the parcel cart near the start
   and see the pear owner retrieve it.
3. Go south for powder or a zapper. Walk over a pickup, then use the same dash
   action near an owner. Powder causes dizziness/puke; zappers shrink NPCs.
4. Tip the two bins, spill fish, overflow the toilet and break the hydrant.
   Dodge bird poop, dog pee and cat puke; lure their attacks into grumps. Water
   washes stains off.
5. Make six fresh rewarded messes: earn +50, then use the five-second warning.
   Ten police leave the Ministry for 25 seconds. Dodge red targets, use cover or
   distract them with creature attacks. They stop attacking and return home.
6. A catch freezes for six seconds. Stand beside a frozen BOT PAL for one second
   to rescue; it attempts the same for you. This companion is local simulation.
7. Explore the west street: ring **NO NOISE**, disturb **FREE SAMPLES**, kick the
   barbecue marked **DO NOT KICK**, or trigger the vacuum. Watch witnesses react
   and the fire crew travel, warn, extinguish and return. Step into water to wash.
8. Collect **THE BIG STINK** south of the starting square. Dash to drop it, then
   escape the marked radius or take cover. At the café, dash the umbrella during
   the inspector's stream and watch the waiter save the cake.
9. Try the gardener in the southeast, laundry in the east, queue in the north and
   mayor's statue northwest of the fountain. Every personality recovers; repeated
   hits do not farm its reward.
10. Pinch or tap +/−, pause/reset, switch apps and return, then rotate your phone.

The immediate feedback to collect is control comfort, readable faces, dash/slide
feel and how much of the market you can see. This trial does not yet answer
whether complete competitive rounds are fun.

## How this reproduces the direction

Original human characters use separately drawn SVG head/torso/limb textures on
Babylon planes, hinged under TransformNodes. Four expressions cover grumpy, angry, surprised and dizzy poses.
Bodies lean, legs splay, brooms swing and cartoon puke appears briefly. The whole assembly faces the fixed camera
at a consistent tilt. Animation changes presentation only.

Stalls and civic/shop/house facades use simple boxes, varied heights, gables, striped awnings and paper colors. Ice and water
are ground quads. A reusable puff plane grows and fades. Texture grain is authored
in the SVG source. No external art tool, physics engine, 3D character rig or
multiplayer server is needed to reproduce this scene.

Six shop owners, eight additional personalities, six creatures, two responding firefighters and ten temporary police are driven by immutable match-state rules. An app-owned routing service memoizes derived geometry outside that state.
Displays tip, fruit rolls, water sweeps, a cart moves, warning targets mark attacks,
and cleanup repairs the square. Ice overlays, countdowns, labels and work bars
communicate danger and recovery. Stalls keep their collision footprints while
tipped. The Ministry doorway is the police departure/return point; outer buildings and furniture now have solid footprints and participate in sight/travel. Their doors are scenery; indoor gameplay is not implemented. Creature cutouts use authored SVG art; droplets, streams, stains
and ground mess display simulation state. Collection/banking, timed
winners, other human players and a complete match objective are not implemented.

## Reliability and loading evidence

The match-state rules run at a fixed 60 Hz with a bounded frame catch-up. Input
cancellation clears movement; backgrounding pauses; resuming consumes stale action
edges. Obstacles stop dashes. A cooldown press is discarded, never queued.

Sixty-six Grumpy Town rule tests pass. Twelve visible-control browser tests cover the expanded trial. They cover
stall damage, slipping, chase/score penalties, bounded raids, freeze/rescue,
collision-clear routes, cleanup/repair, creature attacks/dodges, collateral credit,
washing, obstruction, effect expiry, temporary pranks, personality reactions, route-cache lifecycle, spectacle queue/rewards, crew warning/extinguishing/return and umbrella deflection,
simultaneous touch movement/dash, pinch, keyboard, responsive dimensions and
pause/reset. These tests establish local behavior, not physical-device performance.

The larger square exposed repeated route computation. CPU profiling confirmed
route/sight calculations dominated the synthetic police-wave workload. Exact-key
destination reuse reduced that measured 3,600-tick workload from approximately
6.1 to 4.6 seconds on the development machine before final content tuning. This
is a local CPU observation, not a phone frame-rate or network performance claim.
The app owns one bounded cache, clears it on reset/stop and passes it explicitly
to rule evaluation. Independent owners produce identical simulation snapshots.

The production build lazy-loads the Babylon scene. The main game/engine chunk is
about 253 kB gzip; other engine/shader chunks are separate. That figure alone is
not a cold-transfer measurement. The old approximately 2 MiB generated WebP seed
art and Phaser dependency are removed from this entry. All current visual textures
are generated locally from the shipped source. Vite reports its large uncompressed
chunk warning; the build passes.

Physical iPhone/iPad Safari, ten-minute heat/frame pacing, cold mobile-network
loading and repeated-remount GPU allocation remain unverified. No multiplayer,
host-recovery or production-release claim follows from these local tests.

## Next decision

Try this scene and judge whether different messes create useful escape choices,
whether warnings are readable, and whether six seconds frozen is funny or tedious.
The bot proves mechanics, not the fun of rescuing real friends. No round timer,
qualification target or winner screen is implemented yet.

The current slice collects physical phone feedback and tunes the local loop.
Rallar-only player-hosted multiplayer follows, with explicit recovery behaviour.
Keep the historical separate Grumpy Town server outside this app.

### Invited iPhone guest, 24 November 2026

The guest scanned the desktop lobby QR, joined the town without an account and readied on the iPhone. The desktop owner readied and started the round. The phone then displayed “Recovery could not be confirmed.” This trial verifies invitation and round entry. The round did not finish.

During the failure window the standard Rallar Server recorded match messages with no recipients and event-loop delays up to 3.2 seconds. These observations do not establish which event first interrupted checkpoint agreement. Repeat the trial after reproducing the interruption in two browsers. Verify checkpoint progress, the same final scores on both devices, reload, rematch and host handoff.

The second iPhone trial used a static production build, the countdown fix and revised room presence timing. Both players readied and entered play. The desktop reached tick 673, then confirmed an interruption at that same tick. The server recorded a guest WebSocket disconnect about 32 seconds after connection. It admitted match traffic from both players until the disconnect, with no recorded business-message rejections and a peak event-loop delay of 157 ms during the observed run. The trace does not identify why the device disconnected. Separately, two Chromium clients completed a three-minute round and showed matching results.

To diagnose another iPhone interruption, the host can add `?diagnostics=1` immediately before the invitation fragment before sharing the link. After an interruption, the device shows its last confirmed tick, WebSocket close code, whether the page was hidden and whether it was restored. Only that tab can see the report. Keep the invitation fragment out of bug reports.

A controlled mobile WebKit trial found a separate midround reload failure. After the guest rejoined, the host sent checkpoint hashes but no full snapshot that a newly loaded tab could apply. With the fix, the guest returned to the same match and nickname, received later ticks and moved on the Chromium host’s screen.

On the next physical iPhone trial, Doctor Drip moved and dashed, reloaded midround, and returned to play. The desktop host showed two ready players and RTC input after the reload. Both screens showed Doctor Drip winning 131–50 at the end of the round. The desktop reached tick 5400. A rematch started with both players and RTC input. The host diagnostics did not identify individual dash presses. During the rematch, the iPhone player reported that pinching could hide controls and that pinching back did not restore them.
