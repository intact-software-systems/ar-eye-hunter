# Black-Box Runner Navigation Map

Provider-neutral JSON recipe runner for api-v1: HTTP, WS, RTC, ASSERT, SET,
and PARALLEL steps against managed or external servers. Recipes and their
matrix registration live beside the runner; formation-burst tiers and the
convergence gates are recipes in `tests/api-v1/`, registered in
`recipe-matrix.json`.

## Read First

1. [toApiV1BlackBoxEnvironment](./api-v1-black-box-run.mts#toApiV1BlackBoxEnvironment)
   builds the managed-server environment;
   [createApiV1BlackBoxExecutionToken](./api-v1-black-box-run.mts#createApiV1BlackBoxExecutionToken)
   scopes one invocation. The run entry manages memory or Postgres cluster
   topologies (primary 18080, secondary 18081, tertiary 18082) and writes
   per-server logs.
2. [parseApiV1BlackBoxArgs](./parse-api-v1-black-box-options.mts#parseApiV1BlackBoxArgs)
   resolves backend, profiles, and cluster-only selection; the managed
   cluster profile allow-list lives beside it.
3. [writeArtifacts](./scenario-black-box.ts#writeArtifacts) writes
   `report.json`, `events.jsonl`, `failures.json`, and `metadata.json` into
   the artifact directory after recipe execution; step `outputs` land in the
   report's `outputs` map (the formation tiers capture
   `GET /api/admin/operations/realtime` metrics there at T0/T1/T2).
4. Recipe registration is data: `recipe-matrix.json` binds each recipe to
   profiles, tiers, and required services; the formation-burst tiers are
   `api-v1-group-formation-burst-{small,medium,large}` and the convergence
   gate is `api-v1-state-medium-scale-churn` (constants pinned by
   `packages/tests/shared-test/api-v1-medium-scale-recipe.test.ts` — never
   weakened).
5. `tests/api-v1/api-v1-idempotency-contract.json` is the focused Tier 2
   three-node contract for strict path identity, equal replay, changed-intent
   conflict, caller/scope/document isolation, single-use races, and exact
   AppInbox/receipt/outbox completion.

## Boundaries

The runner owns recipe execution and artifacts; the black-box control
protocol and distributed-run contracts live in `../rallar-bb-test/`. Recipes
assert liveness and contracts; storm quantities are captured, never judged,
and baseline interpretation lives in `playground/rtc-design/baselines/`.
