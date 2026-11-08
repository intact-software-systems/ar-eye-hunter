# Deno → Bun migration

Replace Deno with Bun everywhere Deno runs today, retire Deno Deploy entirely, and re-home production
server hosting on Hetzner across the three controller VMs.

## Goal

All Deno-authored server and tooling code compiles, tests, and runs under Bun; Deno Deploy (apps,
Postgres, token, and workflow jobs) is gone; and the three Hetzner servers host the split production
roles. The existing Node + npm frontend and `packages/**` Vitest surface is untouched.

## Locked decisions

- **Runtime**: Bun replaces Deno everywhere Deno runs today. Node/npm stays for the frontend and
  `packages/**`.
- **Topology (split by role)** across the three servers:

  | Server                             | Role                                                 | Storage                   |
  | ---------------------------------- | ---------------------------------------------------- | ------------------------- |
  | `rallar-controller-fsn1-01` (fsn1) | API-v1                                               | local production Postgres |
  | `rallar-controller-02` (hel1)      | control server + headless workers                    | control snapshots         |
  | `rallar-controller-03` (hel1)      | `relic-hunter-server-v1` + `ar-eye-hunter-server-v1` | local games Postgres      |

- **Data**: fresh start. Deno Deploy Postgres data is not retained.
- **`ar-eye-hunter-server-v1`**: migrate to Bun **and** deploy to 03.
- **Black-box/headless testing**: stays active, co-located with the control server on 02.
- **Sequencing**: hybrid — get everything green on Bun + CI first (Deno Deploy keeps serving its last
  revision as fallback), then cut hosting over app-by-app and retire Deno Deploy last.

## Current state

### Deno runtime surface

Four servers run under Deno today, all with a `deno.json` and no `package.json`:

- `apps/api-v1` — Hono + Prisma/Postgres. `deno.json` has `npm:` imports only (`@js-temporal/polyfill`,
  `@electric-sql/pglite`, `postgres`, `graphology`) plus `@shared*` path aliases. Has Prisma `deno task`
  wrappers and a `deploy` block (`rallar-server`).
- `apps/rallar-black-box-control-server` — WebSocket control plane. Path aliases only, no `jsr:`. Has a
  `deploy` block (`rallar-bb-server`).
- `apps/relic-hunter-server-v1` — game server. Uses `jsr:` (`hono`, `@std/dotenv`, `@std/expect`,
  `@std/testing/bdd`, `@std/yaml`) plus `npm:`. Has a `deploy` block (`relic-hunters`).
- `apps/ar-eye-hunter-server-v1` — game server. `npm:` imports + `@api-v1/` cross-app alias. No
  `deploy` block; not deployed anywhere today.

Deno also drives non-server tooling:

- `packages/shared-rtc-bench` — benchmark CLIs; has both `deno.json` and `package.json`.
- `packages/shared-test/black-box-runner/**/*.mts` — ~26 `.mts` entry points (cluster proofs, topology
  replay, managed-api, recipe-matrix, black-box run, live validation).
- Root `package.json` scripts that shell out to `deno`: `test:deno:platform`, `test:deno:games`,
  `test:postgres:integration`, `test:postgres:presence-expiry`, `perf:api-v1:state-write`, `perf:rtc-*`,
  `dev:api-v1`, `dev:relic-hunter-server-v1`, `dev:rallar:*`, `start:rallar:*`, `db:migrate`, and the
  `test:rallar-server-hardening` suffix.

### Deno-specific APIs in use

`Deno.serve`, `Deno.upgradeWebSocket`, `Deno.Command`/`Deno.spawn`, `Deno.env`, `Deno.readTextFile`/
`readFile`/`writeTextFile`/`mkdir`/`stat`, `Deno.exit`, `Deno.args`, `Deno.cwd`. **No Deno KV, cron,
openKv, or any Deno-Deploy-only service** — the servers are plain HTTP + WS apps over Postgres, so
retiring Deno Deploy needs no feature reimplementation.

`Temporal` is used broadly in `packages/**` via `@js-temporal/polyfill` (already an npm dep, already
exercised under Node by Vitest) and Deno's `--unstable-temporal` flag; Bun/Node get it from the polyfill
or native `Temporal`.

### Deno Deploy footprint

`.github/workflows/deploy.yml` deploys three apps gated behind `vars.DENO_DEPLOY_ACTIONS_ENABLED=true`:
`rallar-server` (api-v1), `rallar-bb-server` (control), `relic-hunters` (relic). Deno Deploy supplies
the production Postgres (`DATABASE_URL` / `DATABASE_URL_RELIC`). `scripts/deploy/verify-deno-deploy-api-configuration.mjs`
and `packages/tests/hetzner/deno-deploy-api-configuration.test.ts` verify its configuration;
`packages/tests/hetzner/deploy-release-gate.test.ts` and `deploy-stale-main-guard.test.ts` assert on the
deploy workflow's Deno jobs.

### Hetzner today

`scripts/hosted-rallar/controller/` provisions a single VM (`rallar-controller-fsn1-01`):
`01-install-runtime.sh` installs Node 24 + Deno + Caddy + Postgres; `02-deploy-controller.sh` and
`08-rollout-controller.sh` install systemd units whose `ExecStart` runs `deno run`, warm Deno caches,
and run `deno task prisma migrate deploy`. This is a black-box/headless testing controller, not the
production API. CI for Hetzner is `deploy-hetzner-controller.yml`, `hetzner-headless-browsers.yml`, and
the distributed-recipe workflows.

## Target architecture

Same code, new runtime and hosting:

- Each server runs **Bun** + **Caddy**, with systemd units whose `ExecStart` invokes `bun`.
- **`fsn1-01`**: api-v1 under Bun + local Postgres (matching today's controller profile). Production
  API host stays `api.rallar.intactss.com`.
- **`02`**: control server under Bun + headless browser workers (Node/Playwright, unchanged) + control
  snapshot storage. `control.rallar.intactss.com` DNS moves here.
- **`03`**: relic + ar-eye game servers under Bun + a local games Postgres. New game subdomains.
- Frontends stay on Cloudflare and call these hosts over HTTPS; they are unaffected by the runtime swap.

## Migration strategy

Hybrid, in two phases:

- **Phase 1 (conversion)**: all Deno code/tooling runs on Bun; CI lanes run on Bun; `deploy.yml` stops
  shipping to Deno Deploy. Deno Deploy keeps serving its last revision as fallback.
- **Phase 2 (cutover)**: convert Hetzner scripts to Bun, split into three roles, point DNS, cut each
  app over, then delete the Deno Deploy apps/Postgres and clean up the verifier/docs.

### Conversion rules

| Deno                                                     | Bun / Node replacement                            |
| -------------------------------------------------------- | ------------------------------------------------- |
| `Deno.serve(handler)`                                    | `Bun.serve({ fetch, websocket })`                 |
| `Deno.upgradeWebSocket`                                  | `Bun.serve` `websocket` handlers (or `node:ws`)   |
| `Deno.env.get(k)`                                        | `process.env[k]`                                  |
| `Deno.Command` / `Deno.spawn`                            | `Bun.spawn` / `node:child_process`                |
| `Deno.readTextFile` / `writeTextFile` / `mkdir` / `stat` | `node:fs/promises`                                |
| `Deno.exit` / `Deno.args` / `Deno.cwd`                   | `process.exit` / `process.argv` / `process.cwd()` |
| `deno test`                                              | `bun test` (`Deno.test` → `bun:test`)             |
| `deno check`                                             | `bunx tsc --noEmit`                               |
| `deno lint`                                              | `bunx eslint`                                     |
| `deno run npm:vitest`                                    | `vitest` / `bunx vitest`                          |
| `deno task <x>`                                          | npm script / `bun run <x>`                        |
| `--unstable-temporal`                                    | `@js-temporal/polyfill` (existing dep)            |
| `jsr:` import map                                        | npm package + tsconfig `paths`                    |
| `deno.json`                                              | `package.json` (npm workspace) + tsconfig         |
| `--allow-*` flags                                        | removed (no permission model)                     |

`jsr:` → npm mapping: `hono` → `hono`, `@std/assert` → `@std/assert`, `@std/path` → `@std/path`,
`@std/dotenv` → `@std/dotenv`, `@std/yaml` → `@std/yaml`, `@std/expect` → `@std/expect`; BDD
`@std/testing/bdd` → `bun:test` `describe`/`it`/`expect`.

The four Deno apps become npm workspaces (they are already inside the root `apps/*` glob). Each gets a
`package.json` and a `tsconfig.json` with `paths` for `@shared*`, `@api-v1/`, `@relic-hunters/`, etc.
(these aliases already exist in the root `tsconfig.json`, root `deno.json` imports, and
`vitest.config.ts` resolve.alias — the Deno apps' local maps are replaced by tsconfig paths). Drop
`@types/deno` and `lib: ["deno.ns"]` from compiler config.

### Conversion is direct, not abstracted

Migrate each `Deno.*` call site to its Bun/Node equivalent in place. Do not add a runtime-abstraction
layer; it would violate the repo's minimum-cognitive-indirection standard and leave a second portable
API to maintain. `Bun.serve` and `Bun.spawn` are idiomatic where they are the natural Deno equivalent;
use `process.env` / `node:fs/promises` / `process.*` for everything else so the code stays readable and
Node-portable.

## Risks

- **Temporal semantics**: verify `@js-temporal/polyfill` is imported before first use under Bun (Deno
  got it from `--unstable-temporal`; Bun/Node need the polyfill import or native `Temporal`).
- **WebSocket shape**: `Bun.serve` WebSocket handler lifecycle differs from `Deno.upgradeWebSocket`;
  the api-v1 and control-server socket paths are the highest-risk rewrites and need the full-stack and
  black-box gates.
- **Prisma under Bun**: Prisma 7 runs its CLI under Node today (`npm exec -- prisma`); confirm `bunx
  prisma` or keep `npm exec prisma` for migrate/generate/validate on the VM and in CI.
- **`.mts` tooling breadth**: the black-box runner's ~26 entry points and `deno run npm:vitest` are the
  long tail; keep them on the same conversion pattern and gate them with the black-box recipe lanes.
- **Cutover ordering**: control server and headless workers must move together on 02; games move last
  so the API cutover is independent.

## Plan

Two slices are concrete now; the rest stays outcome-shaped until their results are known.

### Slice 1 — Bun foundation + reference conversions

Owner: Deno tooling, `packages/shared-rtc-bench`, `apps/ar-eye-hunter-server-v1`,
`apps/rallar-black-box-control-server`.

1. Establish the Bun command conventions in `package.json`: `test:bun:*`, `check` via `bunx tsc`,
   lint via `bunx eslint`. Add a `setup-bun` action for CI and remove `@types/deno`.
2. Convert `packages/shared-rtc-bench` (has both `package.json` and `deno.json`): migrate `Deno.*` and
   `@std/path` → `node:path`, switch its `deno run --config packages/shared-rtc-bench/deno.json` scripts
   (`perf:rtc-*`) to `bun`.
3. Convert `apps/ar-eye-hunter-server-v1` and `apps/rallar-black-box-control-server` (no `jsr:`, no
   Prisma): add `package.json` + tsconfig paths, rewrite `Deno.serve`/`Deno.upgradeWebSocket`/
   `Deno.env`/file I/O, migrate `Deno.test`/`@std/testing` → `bun:test`.

Acceptance: `bun test`, `bunx tsc --noEmit`, and `bunx eslint` pass for these three surfaces; the
`perf:rtc-*` scripts run under `bun`. This fixes the repeatable pattern for Slice 2.

### Slice 2 — api-v1, relic, `.mts` tooling, and CI rewiring

Owner: `apps/api-v1`, `apps/relic-hunter-server-v1`, `packages/shared-test/black-box-runner`, CI.

1. Convert `apps/api-v1`: `Bun.serve` + WS, `process.env`, `node:fs`, `jsr:` free already; keep Prisma
   migrations via `npm exec prisma` / `bunx prisma`. Replace its `deno task` wrappers with npm scripts.
2. Convert `apps/relic-hunter-server-v1`: map `jsr:` `hono`/`@std/*` → npm, `@std/testing/bdd` →
   `bun:test`, `@std/yaml` → `@std/yaml`.
3. Convert the `.mts` black-box runners and `deno run npm:vitest` Postgres integration commands
   (`test:postgres:integration`, `test:postgres:presence-expiry`) to `bun` / `bunx vitest`.
4. Rewrite the `test:deno:platform` / `test:deno:games` npm scripts to invoke `bun test`; rewire the
   `checks` and `deno` lanes of `release-gate.yml` and the `checks-games`/`deno-games` lanes of
   `games-release-gate.yml` from deno → bun.
5. Remove the `deno-deploy-preflight`, `deploy-api`, `deploy-control-server`, and `deploy-relic-api`
   jobs from `deploy.yml`; update/remove the coupled tests (`packages/tests/hetzner/deploy-release-gate.test.ts`,
   `deploy-stale-main-guard.test.ts`), and remove `scripts/deploy/verify-deno-deploy-api-configuration.mjs`
   - `packages/tests/hetzner/deno-deploy-api-configuration.test.ts`. Update `docs/production-deployment.md`.

Acceptance: `npm run test:ci` (now Bun-backed) passes; Release Gate and Games Release Gate run without
Deno; `deploy.yml` no longer references Deno Deploy. Deno Deploy apps remain live as fallback.

### Later slices (outcome-shaped)

- **Hetzner runtime**: `01-install-runtime.sh` installs Bun instead of Deno; systemd `ExecStart` →
  `bun`; `08-rollout-controller.sh` runs `bunx prisma migrate deploy` and warms Bun caches.
- **Three-role split**: per-server provisioning scripts + DNS (`control.*` → 02, new game subdomains →
  03), keeping `api.*` on fsn1-01.
- **Hosting cutover + retirement**: cut each app over to its Hetzner host, verify, then delete the
  Deno Deploy apps and Postgres and remove the remaining docs/secret references.

## Do first

1. Convert `packages/shared-rtc-bench` and the two non-Prisma servers (`ar-eye-hunter-server-v1`,
   `rallar-black-box-control-server`) to Bun, establishing the command conventions and tsconfig pattern.
2. Wire the `bun` test/check/lint commands into the root `package.json` and CI setup action.

## Out of scope

- Frontend apps and `packages/**` Vitest/Playwright/Vite (stay on Node/npm).
- Cloudflare Pages/Workers hosting for the frontends.
- Retaining or migrating Deno Deploy Postgres data (fresh start agreed).
