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
The runner automatically clears prior `fairness-proof.json` before every
managed run; failure triage uses only the current invocation's isolated logs
and fairness proof. This is a test-topology change: run correctness and load
gates, but do not add a new production benchmark or numeric latency SLO unless
production behavior changes.

The dedicated `api-v1-black-box-topology-replay` profile is coordinator-owned,
not a portable recipe. A/B run standard workers and notification listeners;
passive C disables both and must converge N5/N6 through periodic durable replay.
The coordinator then stops C, advances both publisher streams, restarts C' with
a new process identity and non-overwriting log, and proves same-session current
hydration without a post-restart mutation. It writes
`rtc-topology-replay-proof.json` and four logs, including
`api-v1-server-tertiary-restart.log`. A failed run writes a bounded failure
artifact with safe socket topic counts, replay metrics, and stream/cursor state;
it never writes credentials, access tokens, or WebSocket tickets.

## Recipe Tiers

Every `api-v1-black-box`-category matrix entry carries an explicit `tier`
label so a convergence/durability proof is never mistaken for an API
black-box test. The convention: name the evidence source, not the topology.

- **Tier 1 — black-box API**: asserts only request/response/WS observables
  (bodies, headers, revision floors, frames, absence windows). Most entries,
  including all `api-v1-black-box-recipes` portability-profile rows.
- **Tier 2 — convergence/durability proof (SQL evidence)**: additionally
  reads persisted state through `set.state-write-evidence`
  (`resource_inbox`/outbox/receipts). `recipe-matrix.test.ts` derives the tier
  from that usage, so the list is whatever carries the evidence rather than a
  number to keep in step here.
- **Tier 3 — coordinator proof**: coordinator-owned flows that manage server
  processes themselves; not portable matrix recipes. Today this is the
  `api-v1-black-box-topology-replay` profile (`topology-replay/*.mts`), which
  is why no matrix entry carries `tier: 3`.

`recipe-matrix.test.ts` keeps the labels honest: a tier-2 label requires a
`state-write-evidence` step in the recipe and vice versa. New recipes state
their tier when registered; the observability-routed evidence plan (W7)
re-tiers converted recipes from 2 toward 1 as migrations land.
