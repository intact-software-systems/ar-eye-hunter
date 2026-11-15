# Grumpy Town Rallar multiplayer implementation plan

> Use `superpowers:executing-plans` for inline implementation and a fresh final
> review. The user requested the plan and implementation together; continue
> without an additional approval stop.

**Goal:** keep the current offline playground and add optional Rallar accounts,
matchmaking, friends/invitations and playable shared matches with an appointed
browser director. Run Rallar locally and provide a phone-accessible trial.

**Architecture:** Rallar Server is the only backend. The app owns town rules and
the browser director simulates every player in one canonical town. Rallar owns
authentication, social consent, matchmaking, room admission and appointment.
Babylon renders accepted state; transport callbacks never invent scores.

**Stack:** existing TypeScript, Babylon, Vite, Rallar browser APIs, Vitest and
Playwright. Use the existing worktree and PR; no separate CCA server.

**Spec:** [architecture](architecture.md), [Grumpy Town](grumpy-town.md), and the
user's request to make multiplayer and social features optional to solo play.

## Global constraints

- Solo opens without authentication or a server dependency; online code loads on demand.
- Retain joystick, dash/drop, zoom, keyboard/mouse and the present town interactions.
- Online scope is `cca-2d` / `default`; preserve complete `GroupRef` identities.
- Initial online boot uses `rallar.setup`; post-login reconnect uses `rallar.start`.
- Use the public matchmaking/friends/room-entry owners, including confirmation,
  cancellation, consent, blocking, errors and lifecycle disposal.
- Two to four players, a ready lobby, three-minute rounds and a 100-point
  qualification target. Several players can qualify. A rematch uses a new match ID.
- Only a server-appointed current director may advance simulation and outcomes.
  Never appoint by writing metadata or trust a host identity claimed in a payload.
- Start with WS-only transport through Rallar room channels: 30 Hz simulation,
  bounded 20 Hz input, 10 Hz state proposals and explicit recovery commitment.
- Input expires after 250 ms; neutral input replaces held controls on pause/blur.
- Recover from a committed checkpoint under a new appointment, or explicitly
  interrupt the round. Never silently restart time or fabricate preserved scores.
- Keep one canonical rule implementation. Do not run the town once per player
  and accidentally multiply cleanup, hazard movement or police timers.
- Every changed file receives full standards closure, including recursively
  changed support files. Independent untouched code remains outside the work.

## Current evidence and ownership

- `apps/cca-2d/src/main.ts` mounts the lazy solo `PracticeApp`.
- `practice-rules.ts` owns movement and calls `town/rules.ts`; these currently
  assume one player and a simulated companion. This assumption must be resolved
  for multiplayer, while preserving solo behavior.
- `practice-scene.ts` owns Babylon resources; online rendering will reuse its
  town presentation and render distinct human actors instead of a fake peer.
- `packages/shared-web/browser/{matchmaking,friends,rooms/entry}` own optional
  authenticated workflows; inspect their focused tests when wiring them.
- `examples/director-relay`, `examples/room-live-channel`, and
  `examples/browser-startup-room` demonstrate transport and entry contracts.
- `packages/shared-web/browser/director` owns appointment and relay validation;
  public code/tests take precedence over historical prose.

## Review focus

1. Room/account switches and logout must fence late social, room and match results.
2. Two accounts must see the same NPCs, damage, scores and remaining match time.
3. Stale or foreign-room input, old directors, repeated dash and oversized input
   must never affect current authoritative state.
4. Host background/close and lost connections must stop unsafe progress, preserve
   committed outcomes and allow only authorized recovery or explicit interruption.
5. Mobile forms and online overlays must remain usable without obscuring gameplay;
   solo must still work when Rallar is unavailable.

## Slice 1 — optional online entry and social lobby

**Owners:** add `apps/cca-2d/src/online/` for session/lobby lifetime and DOM UI;
modify `main.ts`, `practice-app.ts`, Vite/TypeScript configuration and app README.
Tests belong in `packages/tests/cca-game` and `tests/playwright/cca-2d`.

- [x] Add failing visible-flow coverage: solo without server, open online,
      register/login, create/join room, two-account matchmaking confirmation/cancel,
      friend request/accept/block and explicit invitation entry.
- [x] Wire Rallar setup and session restoration behind the optional online entry.
      Render signed-out, connecting, connected and recoverable error states.
- [x] Compose `RallarRoomEntry`, `RallarMatchmaking` and `RallarFriends`;
      expose room creation, joining, account name, roster and invitations.
- [x] Add a same-origin HTTP/WS proxy and start an isolated local Rallar instance.
      Do not expose credentials or change unrelated app configuration.
- [x] Verify the real flows in independent browser contexts and run CCA build
      and focused typecheck. Publish this coherent slice to the existing draft PR.

## Slice 2 — shared town match and director recovery

**Owners:** add `src/match/` for canonical match state/rules, protocol validation,
Rallar lifecycle and accepted-state presentation. Generalize affected `town/`
rules to a human roster without duplicating their single-player implementation.

- [ ] Write failing domain tests for shared-world stepping, separate player
      controls/scores, rescues, timer/qualification, ready/start/rematch and stale input.
- [ ] Implement canonical roster/town state and fixed-step match simulation;
      preserve the full existing prank, creature, cleanup and authority behavior.
- [ ] Use dedicated Rallar director appointment, current roster/session identity
      and room-scoped channels. Validate protocol/build, scope, match, epoch and sequence.
- [ ] Render each player with a distinct identity; show lobby readiness, director,
      countdown, round timer, individual scores, shared danger and multiple qualifiers.
- [ ] Implement acknowledged checkpoint commitment and bounded recovery with
      current server authority. Clear old controls on a new epoch. Missing agreement
      or eligibility produces an explicit interruption and a fresh ready cycle.
- [ ] Add real two-/three-browser tests for movement, shared interaction, rescue,
      timer/results, rematch, disconnect/reconnect and old-host rejection. Keep solo
      and touch controls covered. Inspect phone/tablet/desktop layouts.
- [ ] Run CCA tests/build/typecheck, applicable shared API tests and structure/style
      review. Obtain fresh independent review and fix substantive findings.
- [ ] Update project/app docs and PR; leave local services running with a verified
      phone URL and explain restart, accounts and remaining physical-device limits.

## Acceptance evidence

`npx vitest run packages/tests/cca-game` must pass domain/runtime regressions.
`npm run build --workspace=cca-2d` must pass the app compiler and bundle.
Visible Playwright coverage must exercise real Rallar services with independent
accounts, not mocked network success or query-string-only gameplay setup.
Record live readiness and preview reachability before handoff. Physical phone
thermal behavior and internet-wide networking require separate device evidence;
emulated browser results must not be represented as those measurements.

## Legacy and boundaries

The older `packages/cca-game` cash/banking model and historical CCA server are
independent of this Grumpy Town entry. Do not wire them into the new match.
The existing local bot remains a deliberate solo feature; remove that assumption
from multiplayer paths. New multiplayer rules must consume the current town rules,
not maintain a parallel version. Any Rallar capability gap that blocks the
requested end state must be fixed and tested at its reusable owner.

## Slice 1 evidence and decisions

The first real-server browser tests pass registration/create-room/return-to-solo
and the two-account friendship, invitation, matchmaking confirmation/entry and
blocking flow. No simulated successful API responses are used. Rallar's strict
room reference decoder requires an exact identity projection when inviting; a
room snapshot must not be serialized as an invitation reference. Matchmaking
entry is asynchronous, so assertions await the new room before comparing peers.

Local API and WebSocket public hosts must agree. The dev client now uses an
explicit API URL rather than pretending a differently configured proxy host is
the advertised API. Local Rallar startup generates ephemeral secrets without
writing them to source or printing them. Secure LAN phone access remains part of
the final serving work, not an already verified property.

Ownership lifecycle is explicit: leaving transfers ownership to another active
member, or archives the temporary town when its last member leaves. Room switches
resolve that departure before entry; sign-out still clears authentication if
departure fails. The lobby excludes departed memberships. Real two-account tests
cover ownership transfer and final-member closure, and returning to solo cancels
an active matchmaking search. Test Rallar uses port 18084 independently of the
user's local server on 8084.

Fault coverage now includes server-committed friend and matchmaking mutations
whose replies are lost, an in-flight search reply held while returning to solo,
and a failed matchmaking read. Explicit retry controls retain request identity.
The session resolves pending search work before cancellation; a missing view is
refreshed and persistent uncertainty is reported. Solo mounts without waiting for
network cleanup, while the next online session waits for that cleanup to finish.

The first match preparation separates `PracticePlayer` and its movement/dash
step from `TownState`. Solo still composes them through the same town rules. A
regression proves two player inputs advance independently without advancing or
copying the shared town. This does not yet implement the multiplayer world step,
director, match lifecycle or recovery protocol.

Local validation for this increment: 67 CCA rule tests, the production build,
five real-server online workflow/fault tests and eight phone/desktop control
checks pass. The earlier full browser pass also covers the police cycle and
all three spectacles. Independent review of the online slice found no remaining
substantive findings after the retry/cancellation fixes. This evidence does not
establish shared gameplay or physical-device networking.
