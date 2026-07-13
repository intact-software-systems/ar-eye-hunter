# Cash Chase Arena — Product Owner Document

Updated: July 13, 2026

## Document authority

This is the product source of truth for Cash Chase Arena (CCA). Technical decisions must implement this document through `Cash_Chase_Arena_Rallar_React_Three_Plans.md`; engineering conventions and quality rules belong in `Cash_Chase_Arena_Engineering_Standards.md`; task order belongs in `Cash_Chase_Arena_Implementation_Plan.md`; character, control, and camera detail belongs in `Cash_Chase_Arena_Characters_Controls_Camera_Plan.md`.

The decisions here incorporate `Cash_Chase_Arena_Complete_Review.md`. When an older prompt or plan conflicts with this document, this document wins on product scope and outcomes.

## Product statement

Cash Chase Arena is an original-IP, browser-native multiplayer chase-survival party game for 2–8 invited players. Players accumulate unbanked credits while active, complete risky missions that force movement, and decide whether to cash out or stay in the arena for a larger score.

The MVP is an unranked, ephemeral, peer-hosted experience. One automatically elected browser acts as the Rallar Game director and owns match truth for the round. Rallar Server provides authentication, rooms, presence, signaling, ICE/TURN configuration, reliable coordination, diagnostics, and recovery coordination. Rallar remains the only application communication platform.

## Product vision

Create a fast-loading multiplayer chase game that reaches a social decision quickly: no install, no engine splash screen, deterministic procedural arenas, short rounds, one-click rematch, and a clear risk/reward choice every few seconds.

“Fast-loading” is a measured product requirement, not a slogan. The lobby must load independently of the 3D renderer and AI/provider code, and deterministic content must always start without waiting for generation.

## Target experience and audience

- Small invited groups playing on desktop browsers.
- Initial round target: 3–6 minutes; default playtest round: 4 minutes.
- Low onboarding cost: movement and the active objective should be understandable within one round.
- Social tension comes from different cash-out decisions, shared mission pressure, visible chases, and rematch rivalry.
- Caught and cashed-out players spectate until the round ends so the active match remains authoritative and easy to understand.
- Mobile browsers may join a lobby or spectator surface only. Touch-only active play is explicitly unsupported in MVP.

## Product principles

- Rallar first: compose existing Rallar APIs before creating app-local infrastructure.
- Director-routed authority over Rallar room RTC; do not claim a physical director-centered star unless Rallar adds and validates that topology.
- Deterministic gameplay and fallback content before AI variation.
- Simulation authority is separate from transport and presentation.
- Browser-director results are room-trusted, not cheat-resistant or server-validated.
- No real money, ranked rewards, progression, or durable CCA results in MVP.
- Procedural visuals before asset-heavy art.
- Characters are identities, not classes; cosmetics never change gameplay.
- Accessibility and failure UX are part of MVP quality.
- Original title, lore, characters, costumes, audio, signage, and UI presentation.

## Core loop

1. Players open an invite link or enter a room code.
2. Rallar restores/authenticates the session and joins a scoped room.
3. Players ready up; Rallar Game reports capabilities, elects a host and backup, and appoints the eligible director.
4. The director commits a validated deterministic arena and three-card mission deck.
5. Clients build the arena and acknowledge readiness.
6. Players earn unbanked credits while active and evade director-controlled Sentinels.
7. Missions create movement pressure and temporary strategic opportunities.
8. A player may cash out, bank all unbanked credits, and become a spectator.
9. A caught player loses all unbanked credits and becomes a spectator; previously banked credits remain.
10. The round ends when the timer expires or no active runners remain.
11. Players see room-trusted standings and can start a rematch without recreating the party.

## Initial playtest configuration

These values are tunable product hypotheses, not protocol invariants:

```text
round duration: 240 seconds
credit accrual: 10 unbanked credits per active second
cash-out availability: standard stations unlock after 60 seconds
mission cadence: one non-overlapping mission every 45–60 seconds
mission alert lead time: 5 seconds
input target: 20 Hz
simulation target: 30 Hz
snapshot target: 12 Hz
players: 2–8
```

The economy, Sentinel pressure, arena scale, mission rewards, and cash-out availability must be configuration values covered by deterministic tests and playtest measurement.

## Gameplay and room lifecycle rules

- One scoped Rallar participant may occupy one active runner seat. A second tab or session for the same participant may observe but cannot ready or control a second runner.
- A participant who joins after `SetupCommit` enters as a spectator and may play after the next rematch readiness reset.
- Any runner who disconnects has a 10-second gameplay reconnect grace period. During grace the last held movement decays to neutral and no edge action repeats. Director loss independently starts authority migration. A returning former director must sync to the current epoch and never regains an old appointment. Grace expiry removes the runner from active play, loses unbanked credits, preserves banked credits, and leaves a reconnecting client as spectator.
- Voluntary leave during an active round follows the same loss-of-unbanked spectator outcome; it never behaves as cash-out.
- Room-governance removal follows the normal disconnect outcome. Removing the director additionally triggers the migration policy.
- Gameplay state does not determine network eligibility. A caught or cashed-out director or backup continues its Rallar role while healthy; migration uses capability/freshness, not runner status.
- Backgrounding is not an AFK penalty by itself. Input resets to neutral; director freshness and browser throttling determine whether migration begins.
- At timer expiry, active runners keep already banked credits and lose unbanked credits. This is an initial playtest rule and may change only through versioned configuration plus updated acceptance tests.
- The round continues with one active runner and ends only on the timer or when no active runners remain.
- Standings sort by banked credits descending, then successful cash-out tick ascending, then stable participant ID ascending. A participant without a successful cash-out sorts after one with the same banked credits.
- Rematch creates a new match ID, seed, setup commit, and readiness cycle; all ready states reset and Rallar Game re-evaluates capabilities/election. The same director may be re-elected.
- If arena construction, renderer recovery, or setup validation fails before start, the round is cancelled without a result and the party returns to an actionable lobby state.

## MVP must-have scope

### Lobby and readiness

- Rallar authentication/session restore.
- Private room create/join/leave with invite link or code.
- Roster, ready state, connection state, director/backup diagnostics, and peer-host disclosure.
- Rallar Game capability reporting, deterministic host/backup election, appointment, and exact/bounded lane readiness.
- Actionable errors for auth, room, signaling, ICE/TURN, RTC, readiness, and unsupported browser/input capability.

### Match

- Versioned deterministic fixed-step simulation.
- Fixed runner capsule and shared movement rules.
- Keyboard/mouse movement, sprint, evasive dash, contextual vault, and interact.
- Third-person soft-follow/orbit camera with obstruction handling and restrained threat assist.
- Director-owned timer, scoring, collision, Sentinel state, mission state, catches, cash-out, and end conditions.
- Exactly three mission templates:
  - disable a Sentinel gate;
  - open a temporary cash-out window or station;
  - activate a double-reward zone.
- Deterministic fallback arenas and mission decks shipped in the pure CCA package.
- Compact full snapshots, reliable critical events, late-join/reconnect sync, and Rallar Motion presentation.
- Pause/re-elect/sync migration that resumes within 10 seconds in controlled tests or terminates the round cleanly.
- Version/build compatibility checks that prevent an incompatible client from readying and explain whether refresh is required.

### Presentation

- Procedural 3D arena with spawn zone, obstacles, terminals, Sentinel gates, reward zone, and cash-out stations.
- Neon capsule or mannequin runners with readable, color-independent silhouettes.
- DOM HUD for timer, banked/unbanked score, mission objective/countdown, interact prompt, threat/link state, and results.
- Native Web Audio cues with mute, volume groups, reduced intensity, voice cap, and no audio-only essential information.
- Hidden operator overlay for Rallar, Motion, simulation, renderer, and recovery diagnostics.

### Local state

- Rallar Data stores validated settings, remapped controls, selected cosmetic preset ID, onboarding/room recents, and bounded local debug artifacts.
- Simulation and match authority do not read Rallar Data during a tick.
- No app-owned CCA match/game data is persisted server-side in MVP.

## Rallar product boundaries

### Rallar Game and Match

Use current Rallar Game for lane presets, capability reports, host/backup election, director appointment, envelope ordering/epoch guards, readiness, input, reliable intents/events, snapshots, sync, diagnostics, participants, standings, and trust labeling.

CCA must not create a parallel `HostLease`, election service, custom channel manager, or raw WebSocket/WebRTC/DataChannel implementation.

Browser-director results are `room-trusted`. If CCA later needs ranked, durable, or reward-bearing outcomes, use the current Rallar Game Authority server path and `server-validated` results.

### Rallar Motion

Use Rallar Motion for remote runner/Sentinel/prop interpolation, adaptive delay, short bounded extrapolation, local prediction correction, discontinuities, kinematic estimates, and presentation diagnostics. It never decides movement, collision, scoring, missions, authority, or recovery policy.

### Rallar Data

Use browser Rallar Data for latest-value local state only. It must not store live input, snapshots, Sentinel state, score authority, director leases, recovery checkpoints, collaborative documents, server AI caches, match summaries, or server-side playtest reports.

### Rallar AI

Rallar AI is post-core, optional proposal infrastructure. Server-side providers may propose arenas, mission decks, flavor, cosmetics, or tutorial copy after deterministic play is stable. Every proposal requires strict schema and domain validation, dedupe/lifecycle handling, a hard deadline, and deterministic fallback. AI never blocks lobby-to-match and never owns live gameplay.

### Rallar CRDT

Rallar CRDT is post-MVP and only for an approved authored collaboration feature such as arena drafts, mission-deck drafts, AI review, or playtest notes. It never owns active match state.

## Authority, trust, and migration

- The MVP director is a player browser; the match is unranked and ephemeral.
- The director runs the authoritative simulation in a dedicated worker once render load exists.
- Rallar appointment epoch is the sole authority epoch.
- The elected backup receives versioned CCA migration checkpoints through a generic Rallar Game migration path.
- When the director becomes stale, all clients pause outcomes, re-elect, appoint a higher epoch, restore the latest acknowledged checkpoint, send a recovery commit/full snapshot, reset presentation discontinuities, and resume on a shared future tick.
- If no valid recovery completes within 10 seconds, the round ends as interrupted and produces no trusted result.
- A returning old director cannot publish accepted outcomes after a higher epoch.

## Accessibility and platform requirements

- All gameplay actions are remappable.
- Menus, lobby, settings, and results are keyboard/focus operable and semantic.
- Essential state is never communicated by color alone or audio alone.
- Support HUD scale, reduced motion, reduced audio intensity, independent volume controls, sensitivity, invert-Y, and high-contrast cues.
- Primary gameplay support target: current stable desktop Chromium/Edge, Firefox, and Safari on macOS, subject to real RTC/TURN tests.
- WebGL context loss, browser backgrounding, audio interruption, offline/online, auth expiry, and stale-client refresh have explicit recover-or-return-to-lobby behavior.
- WebGL2 is the renderer baseline; WebGPU is not required.
- Mobile active play and full gamepad tuning are post-MVP.

## Performance budgets

```text
lobby critical JavaScript: <= 250 KiB Brotli
lazy renderer JavaScript: <= 500 KiB Brotli before assets
cold lobby interactive: <= 2.5 seconds in the agreed Fast-4G lab profile
setup commit to first procedural frame: <= 1.5 seconds on reference desktop
active target: 60 FPS; adaptive low tier: 30 FPS
director simulation step: p95 <= 4 ms at representative 8-player load
snapshot payload: p95 <= 4 KiB at 8 players
host game-data outbound: target <= 3 Mbit/s for 7 remote peers
15-minute application heap: target < 250 MiB and < 5% retained growth after warm-up
```

These are acceptance gates. Claims remain unproven until CCA-specific builds and profiles exist.

## Security, privacy, and disclosure

- Keep AI provider keys, TURN credentials, and other secrets server-side.
- Validate protocol, payload size/shape, sender, scope, match, epoch, sequence, coordinates, rates, cooldowns, phase, and proximity before mutation.
- Sanitize all player and AI text; never render generated HTML.
- Bound room size, queues, prompts, generated object counts, debug logs, TTLs, and local storage.
- Disclose host CPU/upload/battery use and that a peer host can manipulate an unranked room.
- No silent CCA telemetry. Early success metrics use consented manual playtest collection or redacted local export until a separate aggregation/retention policy is approved.
- Apply an explicit CSP/allowed-origin policy and review runtime and asset licenses before release.

## MVP non-goals

- Ranked play, durable results, progression, leaderboards, purchases, real money, or cheat-resistant rewards.
- Rescue or forced-movement missions.
- Combat, classes, perks, abilities, wall-run, slide, roll, crouch, or respawn/reentry.
- Full touch controls, first-person mode, or mobile active play.
- R3F, Drei, postprocessing, a physics engine, external state store, external networking, or external persistence.
- Asset-heavy characters, custom rigs, root-motion authority, or mesh-derived collision.
- AI-required content, browser model downloads, or CRDT creator tools.
- Match replay, public matchmaking, social graph, or voice/video calls.

## Acceptance and success metrics

### Engineering gates

- 2, 4, and 8 browser contexts complete lobby-to-round flows over direct and TURN paths.
- Identical seed and validated inputs produce identical canonical state hashes in Node, Chromium, Firefox, and WebKit worker tests under the engineering numeric contract.
- Wrong room/match/sender/epoch and duplicate/stale messages are rejected before game logic.
- Unsupported protocol/simulation/content versions cannot ready or restore a checkpoint; compatible additive versions pass mixed-version fixtures.
- At least 9/10 controlled director-loss runs resume within 10 seconds with one higher epoch; other runs end clearly without a result.
- Deterministic fallback starts within the startup budget when AI is disabled or fails.
- Supported browser matrix, bundle, frame, simulation, bandwidth, and soak budgets pass.
- Static/tests prove no raw game transports, duplicate election/lease, Rallar Data match authority, or CCA server game persistence.

### Product playtest goals

- Lobby-to-match success rate ≥80% in early external playtests; engineering target is higher in controlled runs.
- Match completion rate ≥60%.
- At least 80% of observed players identify the active mission objective within 5 seconds.
- At least 50% of groups start a second round.
- No single hiding, mission, or cash-out strategy dominates observed successful play.
