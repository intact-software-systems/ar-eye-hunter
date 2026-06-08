# Cash Chase Arena — Implementation Plan
Prepared: May 22, 2026

## Strategy
Build in layers: prove WebRTC peer-hosting first, then add deterministic simulation, then rendering, then AI-generated variety, then migration and deployment hardening.

## Repository structure
```text
cash-chase-arena/
  apps/
    web-client/
    backend/
  packages/
    shared/
    netcode/
    simulation/
    procedural/
  docs/
```

## Runtime architecture
Before match: clients join backend lobby, report capability, receive host lease, exchange WebRTC signaling, receive validated map and mission deck.

During match: clients send input to host over WebRTC; host sends snapshots/events; host replicates state to backup; backend handles recovery only.

## DataChannels
- ctrl: reliable ordered control.
- input: unordered, short lifetime, client to host.
- snapshot: unordered, short lifetime, host to clients.
- event: reliable ordered gameplay events.
- replication: reliable ordered host-to-backup state.
- metrics: unordered diagnostics.

## Milestones
1. Monorepo scaffold.
2. Shared schemas and protocol types.
3. Backend lobby and signaling.
4. Host election and host lease.
5. WebRTC PeerConnectionManager.
6. Negotiated DataChannels.
7. BrowserHostRuntime.
8. Client input and snapshot interpolation.
9. Procedural map validator and fallback maps.
10. Babylon procedural renderer.
11. Sentinel AI.
12. Scoring and cash-out.
13. Mission deck and scheduler.
14. AI layout endpoint with Structured Outputs and validation.
15. Match start handoff.
16. Backup host replication and migration.
17. Debug overlay, playtest hardening, and deployment.

## MVP done definition
- 2-8 players can join a private room.
- Backend elects host and coordinates WebRTC setup.
- Gameplay traffic uses WebRTC after handoff.
- The host browser runs match simulation.
- Players can move, avoid Sentinels, complete missions, cash out, and finish a round.
- Fallback maps work without AI.
- Typecheck, tests, and build pass.
