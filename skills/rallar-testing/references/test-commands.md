# Rallar Test Commands

## Common Focused Commands

```bash
npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts
npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts
npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
npx vitest run packages/tests/shared-server/rallar-server-app-data.test.ts
npx vitest run packages/tests/shared-graph/repositories-and-create-graph.test.ts
npx vitest run packages/tests/relic-hunters/relic-game.test.ts
npm --workspace relic-hunters-v1 run test -- tests/relic-hunters-runtime.test.ts
```

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
```

## Broader Suites

```bash
npm run test:unit
npm run test:deno
npm run test:rallar:full-stack:memory
npm run test:playwright:relic:full-stack
```

## Notes

- Deno tasks are app-local; run them from the app directory unless the root script wraps them.
- Postgres and live RTC suites are opt-in and may need services/env vars.
- Vite game builds commonly emit large chunk warnings; treat exit code as authoritative unless the task is performance-specific.
