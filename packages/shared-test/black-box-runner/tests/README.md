# Black-box Runner Test Recipes

This directory contains executable recipes that are validation fixtures rather
than illustrative examples.

- `api-v1/` holds no-browser `apps/api-v1` REST/WS black-box scenarios run by
  the `api-v1-black-box` matrix profile and release-gate helper.

Use `api-v1-black-box` for full managed helper coverage. Add
`api-v1-black-box-recipes` only to scenarios that can run against an
already-running API without assuming server startup environment beyond the
published API/WS URLs and demo credentials.

Keep API-v1 recipes to HTTP, raw WS, SET, and ASSERT steps. They should not
require Playwright, browser providers, or RTC connections.

## API-v1 Managed Topology

Memory mode manages one API process. Built-in Postgres cluster profiles manage
three Postgres-backed API processes: three Deno API processes sharing one
Postgres database on ports 18080, 18081, and 18082, with isolated `api-v1-server.log`,
`api-v1-server-secondary.log`, and `api-v1-server-tertiary.log` artifacts.
Recipes-only mode is externally managed and starts no API process.

Keep node C meaningful in standard/default, CRDT, and medium-scale cluster
recipes. The medium-scale fixture remains exactly 100 independently
authenticated clients, five groups, 10 client lanes, and five control lanes.
Clear a previous fairness proof before every managed run; failure triage uses
only the current invocation's isolated logs and fairness proof. This is a
test-topology change: run correctness and load gates, but do not add a new
production benchmark or numeric latency SLO unless production behavior changes.
