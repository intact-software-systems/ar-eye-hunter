# Rallar Game Entrypoints

## AR Eye Hunter — Broad Capability Example

- Use as the broad capability example for Rallar Game, director, diagnostics,
  Motion, presence, and AI composition.
- App: `apps/ar-eye-hunter-v1/src/App.tsx`
- Main hook: `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`
- Simulation: `apps/ar-eye-hunter-v1/src/game/simulation.ts`
- AI director: `apps/ar-eye-hunter-v1/src/game/aiDirector.ts`
- Rallar Game adapter: `apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts`
- UI/runtime scene: `apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx`

## Relic Hunters — Preferred Structural Example

- Use its runtime and scene contracts as the preferred structural example for
  authority/presentation boundaries.
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

## Renderer-Neutral Planning Evidence

- `projects/cash-chase-arena/Cash_Chase_Arena_Rallar_React_Three_Plans.md` is
  renderer-neutral planning evidence. Its product decisions and renderer
  bake-off are Cash Chase-specific, not a universal renderer decision.
