# Rallar Test Commands

## AppInbox Mutation Contract

AppInbox is mandatory for incoming database mutations, including every HTTP and
WebSocket client/group/topology, authentication/session/ticket, CRDT append or
admin, and mutating admin path. AppInbox owns the transaction and retry boundary.
The service `write(transaction, computed)` applies pure computed persistence
data: service write receives the transaction and never opens or retries one.

The received transaction writes state, event, receipt, result, and final
`APP_OUTBOX`/`WS_OUTBOX` entries directly through `ResourceInboxRepository`.
There is no intermediate mutation outbox, and authoritative contracts use
mandatory fields by default. Resource inbox permits 20 total processing attempts:
1, 2, 4, 8, and 16 ms for attempts one through five, then increasing seconds
capped at 30 seconds with jitter. Its separate best-effort fairness lane claims
retries more than 30 seconds overdue independently from timeout recovery. Queue
locks are coordination-only, never domain row, table, advisory, or CRDT document
locking precedent. Do not defer or weaken required commands under deadline,
sunk-cost, or authority pressure.

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
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-style-layout-rules.test.ts
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

## Convergent State-Write Gates

For any api-v1 client, group, topology, runtime-state, mutation-path, or
database-concurrency change, run focused tests first and then:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
```

This command is one fixed gate: 100 independently authenticated clients, five
groups, two Postgres-backed API processes, 10 client lanes plus 5 control
lanes. Never reduce these constants, the operation matrix, or the assertions to
make a change pass.

A mutation-path or concurrency-domain change also requires a fresh candidate:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

The comparative result gate must pass. It validates artifact correctness,
receipts/outbox linkage and retry exhaustion, then compares latency,
throughput, SQL/row/byte counts, and transaction duration. Record the exact
artifact paths and command output; do not relabel an older diagnostic artifact
as the governed candidate.

## Plan Completion Gate

Focused checks and surface-specific suites are feedback; they never substitute
for the plan completion gate. From the final uncommitted working tree, run:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any change after a successful command invalidates its result. Before completion,
the draft pull request must be current, **Branch Release Gate** must pass for
the final feature-branch commit, and **Run Hetzner Supported Distributed
Manifests** must pass for the resulting default-branch commit. Verify and record
the exact commit SHA; a Release Gate run on different code is not evidence for
the current plan. Do not approve completion: the plan is not complete while any
required command or workflow is pending, skipped, failed, or attached to an
older commit. An instruction not to commit or push postpones publication but
does not waive any completion gate.

`npm run test:ci` includes the repository Deno, E2E, and in-memory full-stack
suites after unit tests. Run `npm run test:unit` separately as required so its
result is explicit rather than inferred from a later composite failure.

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
