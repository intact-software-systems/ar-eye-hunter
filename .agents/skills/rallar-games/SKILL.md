---
name: rallar-games
description: Use when changing AR Eye Hunter, Relic Hunters, Rallar Game authority, Rallar Motion consumers, game room creation, game UI flows, browser game realtime behavior, or greenfield browser game architecture.
---

# Rallar Games

**REQUIRED SUB-SKILL:** Use `building-rallar-apps` when creating a new browser
game. Keep `rallar-games` focused on existing games and Rallar Game or Rallar
Motion behavior.

## Start Here

Read `references/game-entrypoints.md` for the current app/package map. Then inspect the concrete game path with `rg`; avoid assuming AR Eye and Relic share the same runtime.

Useful searches:

```bash
rg -n "createRoom|rooms.create|createAndSwitch|waitForPresence|joinRoom|roomId|RallarGame|directorAuthority|egress|Squad Link|presenceNotices|authority|motion|rtc|realtime\\.room|messages\\.room|RallarAI" apps/ar-eye-hunter-v1 apps/relic-hunters-v1 apps/relic-hunter-server-v1 packages/relic-hunters packages/shared-web packages/shared
```

## Implementation Guidance

- Keep pure rules in `packages/relic-hunters`; keep browser orchestration in `apps/relic-hunters-v1`.
- Relic server-side authority and expedition setup live in `apps/relic-hunter-server-v1`.
- AR Eye’s main browser hook is `useRallarArena`; Relic’s browser hook is `useRelicHunters`.
- Use package APIs for Rallar Game, Motion, AI, and rooms instead of local duplicates.
- New game-room creation that should replace the current room should use
  `rallar.rooms.createAndSwitch(...)`, then a room-bound handle from
  `rooms.session(...)`.
- For room-scoped game/motion traffic, prefer `rallar.realtime.room<T>(...)` and `rallar.messages.room<T>(...)`; drop to raw RTC readiness/send APIs only for low-level transport tests or custom peer targeting.
- Room handles scope sends, peer selection, and readiness, not receive-side
  filtering. Game message callbacks must validate the `GroupRef` in
  `message.raw.targets` with `isSameGroupRef`; each shared realtime payload
  must carry and validate a full `roomRef`, or use a room-unique realtime lane.
- Use Rallar Game diagnostics for `directorAuthority`, `egress`, ready peers,
  and appointment issues before adding app-local transport heuristics.
- Rallar Game's default browser-director appointment policy allows elected active
  members to appoint only when no owner/admin session and no active director
  session are present. Keep appointment calls on `rallar.director.appoint(...)`,
  not generic room metadata updates.
- AR Eye's browser UI derives Squad Link and presence notices from the Rallar
  connection, RTC lane, and director diagnostics; keep that derivation pure and
  testable.
- Preserve room display-name filters when changing room names; both games filter visible room lists by their base game phrase.
- For frontend changes, validate text fit and real flows with browser/playwright when the UI changes materially.

## Validation

Use the `rallar-testing` skill to select validation commands. Build both game
apps after shared game/realtime changes.
