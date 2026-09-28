# Rallar

Rallar is a browser-first realtime platform for room-based applications. A room
is the product surface. Behind it, API-v1 stores authoritative group state,
serves WebSocket topics, and computes WebRTC overlay topology. Browser code
talks to that server through the Rallar facade.

The platform is the substrate. Games and tools built on it keep their own match
rules, rendering, and product policy.

## Planes

- Control: REST authentication, tickets, and room membership.
- Events: WebSocket topics with server validation, authorization, and fanout.
- Realtime: WebRTC data channels for low-latency peer traffic.
- Persistence: browser `rallar.data` for local latest values, and server app
  data for durable application records.

## What belongs where

- Rallar Data is browser-local latest-value state. It is not live match truth.
- Rallar CRDT is collaborative authored documents. It is not competitive match
  authority.
- Rallar Motion smooths presentation. It is not the simulation.
- Rallar Game keeps match truth on the server. Clients send commands and render
  published snapshots.
- RallarAI output is a proposal until domain code validates and accepts it.

`docs/architecture.md` records why these boundaries exist. `examples/README.md`
shows the smallest copyable use of each surface.

## Fit

| Kind of product                              | Fit                         | What to use                                                                                      |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| Turn-based or async multiplayer              | Strong                      | Rooms, durable group state, validated commands, reconnect, event fanout                          |
| Social or collaborative rooms                | Strong                      | Presence, group state, WebSocket events, local data, server app data                             |
| Casual realtime rooms                        | Good                        | WebRTC realtime lanes for cursors, avatars, and lightweight shared state                         |
| Authoritative matches                        | The game layer              | Server match truth, client commands, Motion only for presentation                                |
| Competitive twitch games or MMO-scale worlds | Outside the current product | Needs interest management, sharding, and game-specific infrastructure this repo does not provide |

## Subproducts

Shared packages are the reusable surface. Apps are consumers.

- `packages/shared` holds runtime-agnostic contracts.
- `packages/shared-web` is the browser facade. Start at
  `packages/shared-web/browser/README.md` and `docs/rallar-api-reference.md`.
- `packages/shared-server` is the server domain. Start at
  `packages/shared-server/README.md`.
- `packages/shared-graph` owns topology generation.
- `packages/shared-test` owns black-box recipes, the control protocol, and
  artifact analysis.
- `apps/api-v1` is the generic Rallar server shell (Deno, Hono, Postgres). It
  is not a game server. See `apps/api-v1/README.md`.
- `apps/ar-eye-hunter-v1` is the broad browser game: rooms, RTC, game
  authority, Motion, and a RallarAI director.
- `apps/relic-hunters-v1` is the browser game with a narrow runtime adapter.
  Its notes live in `apps/relic-hunters-v1/docs/README.md`.
- `apps/relic-hunter-server-v1` composes the Rallar server with Relic rules and
  server-side RallarAI.
- `apps/rallar-black-box` is the operator console for recipes, diagnostics, and
  distributed runs. See `apps/rallar-black-box/docs/README.md`.
- `apps/rallar-black-box-control-server` and `apps/rallar-black-box-headless`
  run and host those distributed browser agents.
- ALM is the message protocol still under design. Start at
  `playground/alm/alm-improvement-plan.md`. The code maps are
  `packages/shared/alm/inbound/README.md` and
  `packages/shared/alm/outbound/README.md`.

## Where to go next

- Build something small: `docs/rallar-quickstart-and-recipes.md` and
  `examples/README.md`.
- Smooth presentation, or keep match truth on the server:
  `docs/rallar-motion-guide.md` and `docs/rallar-game-guide.md`.
- Operate a deployment: `docs/production-deployment.md`,
  `docs/environment-variables.md`, and
  `docs/rallar-troubleshooting-checklist.md`.
- Change the repo: `AGENTS.md` and the skill for the surface you are touching.
