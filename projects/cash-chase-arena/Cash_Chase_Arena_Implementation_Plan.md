# Cash Chase Arena (CCA) — Implementation Plan
Prepared: May 22, 2026

## Strategy
Build in layers: prove Rallar-backed WebRTC peer-hosting first, then add deterministic simulation, then Rallar Motion-backed snapshot presentation, then a fixed gameplay capsule and simple character vertical slice, then browser-local Rallar Data preferences/debug persistence, then rendering and game feel, then Rallar AI-generated variety, then optional post-MVP Rallar CRDT collaboration tools, then migration and deployment hardening.

## Repository structure
```text
ar-eye-hunter/
  apps/cash-chase-arena/
  packages/cash-chase-core/
  projects/cash-chase-arena/
```

## Runtime architecture
Before match: clients join a Rallar room, report capability, receive or derive a browser director lease, use Rallar room transport helpers to check/wait for realtime readiness, and receive a validated map and mission deck from deterministic fallback content or an accepted Rallar AI proposal. MVP CCA does not persist match/game data server-side; any generated or accepted setup data is transmitted into the room/match flow and then owned by the browser director simulation.

During match: clients send input to the browser director through `rallar.realtime.room<T>(...)`; the director sends snapshots/events through room realtime/message helpers; clients route accepted snapshots through Rallar Motion before rendering; the director replicates state to backup when enabled; backend handles coordination and recovery only.

Browser Rallar Data may persist local settings, selected cosmetic loadout IDs, last-used room hints, local AI proposal replay, and local debug logs. It must not sit in the active input/snapshot/simulation path, and MVP CCA must not use server app data for match/game data.

## Server persistence boundary

In MVP, CCA must not persist app-owned match or game data on the server. Server-side persistence is limited to data that belongs to Rallar Server itself, such as Rallar infrastructure state for auth/session/room/signaling/runtime behavior.

Do not persist these CCA values server-side in MVP:

- match state
- director snapshots
- input history
- score or cash-out results
- Sentinel state
- mission state
- recovery state
- replay state
- match summaries
- playtest reports
- Rallar AI proposal caches
- content catalogs
- CCA-specific fallback arena or mission catalogs

Server-side Rallar AI may generate and validate proposals in MVP, but accepted proposal data must be sent into the match setup flow and not retained as CCA server app data.

## Character development boundary

CCA characters are identities, not classes. Character development is split into:

- fixed gameplay capsule owned by `packages/cash-chase-core`
- renderer-owned visual character in `apps/cash-chase-arena`
- presentation-only animation driven by simulation state

Cosmetics must not alter collision, movement, stamina, dash, vault, interact range, Sentinel visibility, scoring, cash-out, or animation timing used by simulation. Start with R3F neon capsules, then a simple modular mannequin, then one shared humanoid rig and GLB/glTF assets after readability is proven.

## Rallar AI boundary

Rallar AI is the CCA creative proposal layer. It may generate candidate arena layouts, mission decks, arena flavor, cosmetic preset suggestions, tutorial text, and playtest analysis. CCA validators must accept or reject every proposal before use.

Rallar AI must not own simulation, Sentinel chase behavior, movement, collision, scoring, mission legality, cash-out legality, host election, authoritative snapshots, anti-cheat, or network protocol decisions.

## Rallar Data boundary

Rallar Data is latest-value application storage. In MVP, CCA uses browser `rallar.data` only for local/player-owned values that should survive reloads or coordinate across tabs. Do not use server `rallar.data.open(...)` for CCA match/game data in MVP.

Good CCA browser stores:

- `cca-settings`: audio, graphics, input, accessibility, and HUD preferences
- `cca-loadout-selection`: selected cosmetic loadout ID and local cosmetic UI state
- `cca-room-recents`: last-used room codes and lobby preferences
- `cca-ai-replay`: local replay/cache of accepted Rallar AI proposals
- `cca-debug-log`: bounded local playtest and transport diagnostics

Do not use Rallar Data for live player positions, input streams, director snapshots, Sentinel state during a match, active score, caught/cash-out authority, host election, recovery leases, collaborative arena editing, authoritative inventory/unlocks, server-side AI proposal caches, content catalogs, match summaries, playtest reports, or any other server-side CCA game data in MVP.

## Rallar Motion boundary

Rallar Motion is the CCA presentation smoothing layer for received snapshots. Use it for remote entity interpolation, adaptive snapshot delay, short-gap extrapolation, local prediction correction, and discontinuity handling for dash, respawn, cash-out, caught, spectator, and recovery transitions.

Rallar Motion must not own simulation, collision, scoring, Sentinel decisions, mission legality, host election, recovery policy, or anti-cheat.

## Rallar CRDT boundary

Rallar CRDT is optional authored-state collaboration for lobby planning, arena drafts, mission deck drafts, Rallar AI proposal review, playtest notes, post-match annotations, or creator-mode scratch documents. In MVP, do not use server-durable CRDT documents for CCA match/game data; CRDT collaboration is post-MVP unless it is explicitly local-only or otherwise not persisted server-side.

Rallar CRDT must not own player positions, director snapshots, Sentinel state, credits, caught state, cash-out, mission completion, host election, recovery state, inventory, unlocks, or anti-cheat. Live match authority remains director-owned or, in a later server-authoritative mode, server-owned.

## Rallar realtime lanes
- ctrl or intent: reliable ordered control through Rallar Director Relay.
- input: unordered, short lifetime, client to director.
- snapshot: unordered, short lifetime, director to clients.
- event: reliable ordered gameplay events.
- replication: reliable ordered director-to-backup state.
- metrics: unordered diagnostics.

## Milestones
1. Monorepo scaffold.
2. Shared schemas and protocol types.
3. Rallar room, session, and signaling integration.
4. Browser director election and lease.
5. Rallar room transport readiness through `rallar.realtime.room<T>(...)`.
6. Rallar Game lane routing, room message fallback, and backpressure.
7. BrowserDirectorRuntime.
8. Client input and Rallar Motion snapshot interpolation.
9. Procedural map validator and fallback maps.
10. Fixed gameplay capsule and simple neon runner vertical slice.
11. Browser-local Rallar Data settings, loadout selection, local AI replay, and debug stores.
12. React Three Fiber procedural renderer.
13. Sentinel AI.
14. Scoring and cash-out.
15. Mission deck and scheduler.
16. Modular mannequin, in-place animation mapping, and curated cosmetic presets.
17. Rallar AI layout, mission deck, and cosmetic proposal generation with validation.
18. Match start handoff.
19. Backup host replication and migration.
20. Debug overlay, playtest hardening, and deployment.
21. Optional post-MVP Rallar CRDT lobby, AI-review, or creator documents after the core loop is stable.

## MVP done definition
- 2-8 players can join a private room.
- Rallar room state and director helpers elect or expose the browser host.
- Gameplay traffic uses Rallar realtime lanes after handoff.
- The host browser runs match simulation.
- Clients use Rallar Motion to render accepted snapshots smoothly.
- Runner cosmetics use the same gameplay capsule and do not affect rules.
- Local preferences and debug artifacts persist through Rallar Data without affecting match authority.
- No app-owned CCA match/game data persists server-side in MVP.
- Players can move, avoid Sentinels, complete missions, cash out, and finish a round.
- Fallback maps work without AI.
- Rallar CRDT is not required for basic play and is not used for live match authority.
- Typecheck, tests, and build pass.
