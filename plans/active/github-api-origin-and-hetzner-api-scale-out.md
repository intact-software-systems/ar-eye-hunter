# GitHub-origin API and Hetzner API scale-out

## Goal

Make the distributed-recipe API/Postgres origin configurable (Hetzner vs GitHub
workflow) and scale the Hetzner API role to three replicas sharing one Postgres,
so 50-agent distributed runs stop depending on a single Hetzner `api` VM as a
hard bottleneck.

## Evidence-backed constraints

- **GitHub-hosted runners have no public ingress and no cross-job networking.**
  A GitHub-run `api-v1` is only reachable by agents co-located on the same
  runner (the existing single-runner `all-local` observation path). It cannot be
  reached by the ~17 sharded GitHub agent jobs that a 50-agent run needs
  (`agents_per_job=3`, `max_parallel_jobs=17`).
- **Multi-instance `api-v1` is already supported**: `database.pubSub: 'postgres'`
  enables N `api-v1` processes sharing one Postgres with cross-instance WS/RTC
  pubsub (LISTEN/NOTIFY). This is the supported scale-out model.
- **The Hetzner control server does not call the API directly**; only the
  headless browser agents hit the API (register/login/ensure-group/WS) over the
  public internet.
- **Postgres on the Hetzner `api` role is active after the Bun upgrade** —
  confirmed by inspect run `42512191245`: `services.postgres = "active"`, all 25
  migrations applied, database `rallar_api_v1` live.

## Decision

`api_origin: hetzner | github` where `github` is limited to the single-runner
`all-local` observation path (the only place a GitHub-hosted API is reachable),
and the Hetzner `api` role scales out to three replicas behind one Postgres.

GitHub limits `workflow_dispatch` to 25 inputs and this workflow already has 25,
so the origin is folded into `execution_mode` as a third value
(`all-local-postgres`) rather than a new input.

## Slices

### Slice 1 — Configurable API/Postgres origin

Add `all-local-postgres` to the `execution_mode` choice on
`.github/workflows/github-free-distributed-recipe.yml`. `hetzner-control`
preserves the Hetzner API/Postgres path. `all-local` stays pglite-`memory`.
`all-local-postgres` runs the single-runner observation with a real Postgres
service container (`RALLAR_BLACK_BOX_API_MODE=postgres` + migrations), proving
the "Postgres in the GitHub workflow" origin.

### Slice 2 — Hetzner API scale-out to three replicas

Split `rallar-api-v1.service` into three replica services (ports
`8080`/`8081`/`8082`) sharing the one `rallar_api_v1` Postgres store with
`RALLAR_DB_PUBSUB=postgres`, and change the role Caddyfile to round-robin
`reverse_proxy` across the three ports. Re-run the 50-agent GitHub Free recipe
to green.

## Acceptance

- `execution_mode=all-local-postgres`: the single-runner observation completes
  with a Postgres service container backing the API; `all-local` (memory) and
  `hetzner-control` are unchanged.
- `api.rallar.intactss.com` serves from three replicas; the 50-agent distributed
  recipe passes.

## Validation

- Slice 1: `npx tsc -p packages/shared-test/tsconfig.json --noEmit`; the
  full-stack distributed-manifest Playwright spec; a local all-local run.
- Slice 2: Hetzner inspect (`postgres: active` + three replicas), then
  `Run GitHub Free Distributed Recipe` (50-agent) to terminal green.
