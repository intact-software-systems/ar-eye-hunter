# Rallar Test Commands

## AppInbox Mutation Contract

Read
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
for the authoritative AppInbox mutation contract and its verification matrix.
This command catalog selects the smallest checks that exercise that contract;
it does not redefine transaction, retry, convergence, or locking policy.

## Common Focused Commands

```bash
npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts
npx vitest run packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts
npx vitest run packages/tests/shared-web/rooms/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts
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
npm run test:repo-governance
```

Run this after changing repo skills, plugin metadata, active Rallar examples,
startup guidance, or root app-path configuration.

## Group-State Traceability QA

Use behavior-named test modules for route-owner analysis and semantic mutation
boundaries. PR A owns this discoverability batch:

```bash
npx vitest run \
  packages/tests/shared-server/mutation-route-owner-analysis.test.ts \
  packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts \
  packages/tests/shared-server/mutation-route-owner-provenance.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts \
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts \
  packages/tests/shared-server/mutation-route-owner-logical-predicates.test.ts \
  packages/tests/shared-server/mutation-route-owner-call-effects.test.ts \
  packages/tests/shared-server/mutation-route-owner-object-projections.test.ts \
  packages/tests/shared-server/mutation-route-owner-map-projections.test.ts \
  packages/tests/shared-server/mutation-route-owner-lexical-resolution.test.ts \
  packages/tests/shared-server/mutation-route-owner-call-aliases.test.ts \
  packages/tests/shared-server/mutation-route-owner-control-flow-alternatives.test.ts \
  packages/tests/shared-server/mutation-route-owner-loop-and-switch-flow.test.ts \
  packages/tests/shared-server/mutation-route-owner-execution-state.test.ts \
  packages/tests/shared-server/mutation-route-owner-abrupt-completion.test.ts \
  packages/tests/shared-server/mutation-route-owner-loop-completion.test.ts \
  packages/tests/shared-server/mutation-route-owner-loop-divergence.test.ts \
  packages/tests/shared-server/mutation-route-owner-loop-fixed-point.test.ts \
  packages/tests/shared-server/mutation-route-owner-state-coalescing.test.ts
```

PR B uses the focused semantic entry, transaction, and exit suites:

```bash
npx vitest run \
  packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts \
  packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
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
npm run test:api-v1:black-box:postgres:topology-replay
```

Use `memory` for fast local feedback, `postgres` when Postgres is available,
and `recipes` when validating against an already-running API.

### API-v1 Black-Box Topology And Artifacts

`memory` manages one API process. Built-in Postgres cluster profiles manage
three Deno API processes sharing one Postgres database on ports 18080, 18081,
and 18082. Their logs stay isolated as `api-v1-server.log`,
`api-v1-server-secondary.log`, and `api-v1-server-tertiary.log` under the
API-v1 artifact directory.

The topology replay command creates an isolated PostgreSQL database and runs
the deterministic A/B/C, N1-N6 proof. C has database notifications and
QueueBox workers disabled, so its live convergence must be poll-driven. The
coordinator stops C, advances both publisher streams, starts C' with a new
identity, and reconnects the same N5/N6 sessions without a post-start mutation.
Inspect `rtc-topology-replay-proof.json` and the A/B/C/C' logs. On failure,
classify startup, readiness, append, replay, transport, assertion, cleanup, or
infrastructure from the bounded current-run failure artifact before changing
code. Do not increase readiness limits or reduce page/workload constants.

Recipes-only mode is externally managed: it neither starts nor stops API
processes. Standard/default, CRDT, and medium-scale Postgres recipes must make
node C meaningful; inspect all three logs and the current-run fairness proof
when a managed cluster run fails. The runner automatically clears prior
`fairness-proof.json` at the start of each invocation, so a failed run cannot
inherit stale proof as current evidence.

The three-server runner is a test-topology change. Run the applicable focused
correctness and load gates, but do not add a new production performance
benchmark or numeric SLO unless the change also alters a production mutation
path or concurrency domain.

## Convergent State-Write Gates

For any api-v1 client, group, topology, runtime-state, mutation-path, or
database-concurrency change, run focused tests first and then:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
```

This command is one fixed gate: 100 independently authenticated clients, five
groups, three Postgres-backed API processes, 10 client lanes plus 5 control
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
throughput, SQL/row/byte counts, and transaction duration. Latency and
throughput comparisons tolerate 5% run-to-run variance; SQL and
transaction-duration median increases require recorded regression reasons.
Benchmark each side against a freshly migrated database — a database dirtied
by an earlier bench run biases the later run's numbers. On noisy hosts,
escalate to the order-balanced A-B-B-A pooling protocol
(`pool-api-v1-state-write-results.mjs`) before concluding a regression. Record
the exact artifact paths and command output; do not relabel an older
diagnostic artifact as the governed candidate.

## PostgreSQL Shared-Server Integration

The default unit suite excludes `packages/tests/shared-server/integration/**`.
Run the live PostgreSQL behavior separately against a migrated test database:

```bash
npm run db:test:up
npm run test:postgres:integration
npm run test:postgres:presence-expiry
```

`test:postgres:integration` owns the reusable repository and true-overlap
concurrency cases. Run `test:postgres:presence-expiry` separately and last
because it retains fixed-ID outbox evidence that can affect later global
outbox workers. Release Gate follows this same order.

## Working-Plan Validation Routing

`adaptive-plan-execution` owns working-plan validation scope. Use this catalog for
the affected behavior, type, build, browser, and explicitly required high-risk
proofs; do not expand a Markdown-only change into unrelated local suites.

## UI Workflow Testing

- Prefer role/label selectors over implementation selectors.
- Start from a realistic logged-in or unauthenticated screen.
- Click and type through the visible workflow a human would operate.
- Verify the state the user cares about plus hidden browser state when the bug is state-related.
- For popups, auth, storage, realtime, downloads, or navigation, assert URL cleanup, localStorage/sessionStorage, requests, visible status, session IDs, connected agents, or artifacts.

```bash
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/control-foundation-local-smoke.spec.ts
```

## Notes

- Deno tasks are app-local; run them from the app directory unless the root script wraps them.
- Postgres and live RTC suites are opt-in and may need services/env vars.
- Vite game builds commonly emit large chunk warnings; treat exit code as authoritative unless the task is performance-specific.
