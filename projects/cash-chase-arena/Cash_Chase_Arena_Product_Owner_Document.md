# Cash Chase Arena (CCA) — Product Owner Document
Prepared: May 22, 2026

## Product summary
Cash Chase Arena (CCA) is a browser-native multiplayer chase-survival game. Players enter a bounded arena, earn credits every second they survive, complete risky missions for bonuses, and choose whether to cash out early or keep playing for a larger score. The match is run primarily through WebRTC after setup: one automatically selected browser acts as the temporary match host, while the backend is used only for bootstrap, signaling, Rallar AI content generation, ICE configuration, and recovery.

The product should be original IP. Keep the universal mechanics of tag, survival, timed missions, score pressure, and risk management, but avoid direct names, visuals, lore, costumes, music, and UI presentation from existing shows.

## Product vision
Create the fastest-loading multiplayer chase game on the web: no install, no traditional engine download, instant procedural arenas, and a social party-game feel.

## Principles
- WebRTC first after handoff.
- Minimal backend for lobby, signaling, host election, ICE, AI, and recovery.
- Automatic peer host with general product disclosure.
- Procedural graphics before high-fidelity art.
- Original title, lore, visuals, and terminology.
- Cheating protection deferred, but host-owned state retained for consistency.
- No CCA match or game data is persisted server-side in MVP; server persistence is limited to data owned by Rallar Server itself.
- Characters are identities, not classes: cosmetics may change appearance but not gameplay stats.
- Browser Rallar Data can persist local preferences, local caches, and local debug artifacts, but it must not own live match truth.
- Rallar Motion can smooth received match snapshots, but it must not own rules or authority.
- Rallar CRDT can support collaborative planning and review documents, but it must not own live match truth.
- Rallar AI output is candidate content only and must be validated before use.

## MVP must-have scope
- Browser lobby with room code or invite link.
- Automatic host election.
- Rallar signaling for WebRTC offer/answer/ICE exchange.
- Star topology: players connect to elected browser host.
- Rallar realtime lanes for input, snapshots, reliable events, metrics, and replication.
- Snapshot presentation smoothing through Rallar Motion.
- Local settings, selected cosmetic loadout, and browser-local debug/playtest artifacts can persist through Rallar Data.
- Cosmetic-only runner characters with a fixed gameplay capsule and readable neon-athlete silhouettes.
- Procedural arena with spawn zone, obstacles, terminals, Sentinel gates, and cash-out stations.
- Host-owned match runtime with timer, scoring, Sentinel state, missions, and eliminations.
- Three mission templates: disable gate, open cash-out, double reward zone.
- Fallback map if AI generation fails.
- Basic peer-hosting disclosure.

## Core loop
1. Players join a lobby by link.
2. The system elects a browser host and builds WebRTC connections.
3. The backend generates or retrieves a validated arena layout and mission deck.
4. Clients build the arena locally.
5. The match starts; players earn credits every second alive.
6. Host-controlled Sentinels patrol, chase, and tag runners.
7. Missions create pressure and force movement.
8. Players cash out or keep playing.
9. Caught players lose unbanked score.
10. The round ends by timer, last-runner condition, or game mode.

## Networking decision
Use a Rallar-backed WebRTC-first super-peer architecture. One player browser becomes temporary host. Other peers send input to that host through Rallar realtime lanes. The host simulates the match and broadcasts snapshots/events. The backend remains a coordinator and recovery service.

## Character development decision
CCA characters should be developed as three separate tracks: a fixed gameplay capsule, renderer-owned visual identity, and presentation-only animation. The simulation owns movement, collision, stamina, dash, vault, scoring, and state. The renderer owns meshes, trails, materials, animation blending, and cosmetic presentation.

MVP characters should start as simple neon capsule runners, then move to a simple modular mannequin, then to one shared humanoid rig with curated presets. GLB or glTF character assets come after the capsule/mannequin vertical slice proves scale, camera readability, and Rallar Motion presentation.

No character cosmetic may change collision, movement, animation timing used by simulation, Sentinel visibility, interact range, scoring, or cash-out behavior.

## Rallar Data decision
CCA should use Rallar Data for browser-local latest-value application storage, not realtime gameplay, collaboration, or server-side CCA persistence. Browser `rallar.data` fits local/player-owned values that should survive reloads or coordinate across tabs.

Good MVP uses include control bindings, audio/graphics settings, selected cosmetic loadout ID, tutorial flags, last-used room code, local debug logs, and local Rallar AI proposal replay.

CCA must not use Rallar Data for live player positions, input streams, director snapshots, Sentinel state during a match, active score, caught/cash-out authority, host election, recovery leases, collaborative arena editing, authoritative inventory/unlocks, server-side AI proposal caches, content catalogs, match summaries, playtest reports, or other server-side CCA game data in MVP. Use Rallar Game for match traffic, Rallar Motion for render smoothing, and Rallar CRDT only for post-MVP or explicitly non-server-persisted collaborative documents.

## Rallar Motion decision
CCA should use Rallar Motion in the browser presentation layer for remote runner, Sentinel, pickup, and moving-prop interpolation. Rallar Motion may provide adaptive delay, short-gap extrapolation, prediction correction, and discontinuity handling for dash, caught, respawn, cash-out, spectator, and recovery transitions.

Rallar Motion must not decide movement legality, collision, scoring, Sentinel behavior, mission completion, cash-out legality, host election, or anti-cheat. The host or selected authority remains the source of match truth.

## Rallar CRDT decision
CCA may later use Rallar CRDT for collaborative authored documents around the match: lobby planning, arena drafts, mission deck drafts, Rallar AI proposal review, playtest notes, and post-match annotations. This is post-MVP unless the document is explicitly local-only or otherwise not persisted server-side.

CCA must not use Rallar CRDT for player positions, live snapshots, Sentinel state, credits, caught state, cash-out, mission completion, host election, recovery state, inventory, unlocks, or anti-cheat. Accepted CRDT-authored content must be committed once through the normal match setup path before it affects a round.

## Rallar AI Director decision
The CCA AI Director uses Rallar AI as a creative proposal layer before a match starts. Rallar AI may generate candidate arena layouts, mission decks, arena flavor, cosmetic preset ideas, tutorial copy, and playtest-tuning suggestions. The backend or selected authority validates and accepts proposals before they affect a match.

Rallar AI must not decide live Sentinel behavior, movement legality, scoring, cash-out legality, host election, authoritative snapshots, or anti-cheat. The browser host runs accepted mission decks locally during browser-director matches, and deterministic CCA validators remain the source of truth.

## Success metrics
- 2-8 player lobby-to-match success rate >= 80% in early playtests.
- Match completion rate >= 60%.
- Host migration recovers within 10 seconds in controlled tests.
- Players understand mission objective within 5 seconds of alert.
- At least 50% of playtest groups start a second round.
