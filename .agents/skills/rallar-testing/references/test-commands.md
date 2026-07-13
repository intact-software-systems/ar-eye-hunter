# Rallar Test Commands

## Common Focused Commands

```bash
npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts
npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts
npx vitest run packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts
npx vitest run packages/tests/shared/webrtc-connection-service.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts
npx vitest run packages/tests/shared-web/browser-middleware-rtt.test.ts packages/tests/shared-web/browser-al-runtime-stores.test.ts
npx vitest run packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-diagnostics.test.ts packages/tests/ar-eye-hunter-v1/squadLink.test.ts packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts
npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
npx vitest run packages/tests/shared-server/rallar-server-app-data.test.ts
npx vitest run packages/tests/shared-graph/repositories-and-create-graph.test.ts
npx vitest run packages/tests/relic-hunters/relic-game.test.ts
npm --workspace relic-hunters-v1 run test -- tests/relic-hunters-runtime.test.ts
```

## Skills And Active Documentation

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```

Run this after changing repo skills, plugin metadata, active Rallar examples,
startup guidance, or root app-path configuration.

## Type Checks And Builds

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
cd apps/api-v1 && deno task check
cd apps/relic-hunter-server-v1 && deno task check
cd apps/rallar-black-box-control-server && deno task check
npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts
npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/control-agent-board.test.ts packages/tests/rallar-black-box/world-fleet-distributed-manifests.test.ts packages/tests/rallar-black-box/world-fleet-runner.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts
npx vitest run packages/tests/rallar-black-box-headless/headless-status-view.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
cd apps/rallar-black-box-control-server && deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/api-black-box.test.ts
```

## REST API Black-Box Practice

When adding or changing REST API behavior, add or adjust Rallar black-box
recipes/tests in `packages/shared-test/black-box-runner` as part of the same
change. For `apps/api-v1`, use the no-browser black-box scripts:

```bash
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:recipes
```

Use `memory` for fast local feedback, `postgres` when Postgres is available,
and `recipes` when validating against an already-running API.

## Broader Suites

```bash
npm run test:unit
npm run test:deno
npm run test:rallar:full-stack:memory
npm run test:playwright:relic:full-stack
```

## UI Workflow Testing

- Prefer role/label selectors over implementation selectors.
- Start from a realistic logged-in or unauthenticated screen.
- Click and type through the visible workflow a human would operate.
- Verify the state the user cares about plus hidden browser state when the bug is state-related.
- For popups, auth, storage, realtime, downloads, or navigation, assert URL cleanup, localStorage/sessionStorage, requests, visible status, session IDs, connected agents, or artifacts.

```bash
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
```

## Notes

- Deno tasks are app-local; run them from the app directory unless the root script wraps them.
- Postgres and live RTC suites are opt-in and may need services/env vars.
- Vite game builds commonly emit large chunk warnings; treat exit code as authoritative unless the task is performance-specific.
