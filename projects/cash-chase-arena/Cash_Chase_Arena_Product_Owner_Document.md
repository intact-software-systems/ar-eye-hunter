# Cash Chase Arena — Product Owner Document
Prepared: May 22, 2026

## Product summary
Cash Chase Arena is a browser-native multiplayer chase-survival game. Players enter a bounded arena, earn credits every second they survive, complete risky missions for bonuses, and choose whether to cash out early or keep playing for a larger score. The match is run primarily through WebRTC after setup: one automatically selected browser acts as the temporary match host, while the backend is used only for bootstrap, signaling, AI layout generation, ICE configuration, and recovery.

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
- AI output must be validated before use.

## MVP must-have scope
- Browser lobby with room code or invite link.
- Automatic host election.
- WebSocket signaling for WebRTC offer/answer/ICE exchange.
- Star topology: players connect to elected browser host.
- DataChannels for input, snapshots, reliable events, metrics, and replication.
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
Use a WebRTC-first super-peer architecture. One player browser becomes temporary host. Other peers send input to that host. The host simulates the match and broadcasts snapshots/events. The backend remains a coordinator and recovery service.

## AI Director decision
The AI Director generates candidate maps and mission decks before a match starts. The backend holds API credentials and validates output. The browser host runs the mission deck locally during the match.

## Success metrics
- 2-8 player lobby-to-match success rate >= 80% in early playtests.
- Match completion rate >= 60%.
- Host migration recovers within 10 seconds in controlled tests.
- Players understand mission objective within 5 seconds of alert.
- At least 50% of playtest groups start a second round.
