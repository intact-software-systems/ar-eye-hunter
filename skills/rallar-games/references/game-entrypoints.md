# Rallar Game Entrypoints

## AR Eye Hunter

- App: `apps/ar-eye-hunter-v1/src/App.tsx`
- Main hook: `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`
- Simulation: `apps/ar-eye-hunter-v1/src/game/simulation.ts`
- AI director: `apps/ar-eye-hunter-v1/src/game/aiDirector.ts`
- Rallar Game adapter: `apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts`
- UI/runtime scene: `apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx`

## Relic Hunters

- App: `apps/relic-hunters-v1/src/App.tsx`
- Main hook: `apps/relic-hunters-v1/src/game/useRelicHunters.ts`
- Browser runtime: `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`
- Rules/model package: `packages/relic-hunters/src`
- Server game service: `apps/relic-hunter-server-v1/src/relic-game-service.ts`
- Expedition AI setup: `apps/relic-hunter-server-v1/src/relic-expedition-ai.ts`
- Current scene runtime: `apps/relic-hunters-v1/src/game/RelicSceneNext.tsx`

## Shared Game Infrastructure

- Rallar Game package: `packages/shared/rallar-game`
- Browser authority client helpers: `packages/shared-web/game`
- Motion package: `packages/shared/rallar-motion`

