# Deno → Bun branch verification plan

Validation gate that runs **before** `claude/deno-to-bun-migration-plan` (PR #794) merges to `main`.
It proves the Bun build behaves on the real Hetzner fleet, that the re-wired GitHub workflows still
deploy, smoke, and run distributed recipes correctly, and that the scalability and performance gates
hold. It changes no product code — it is the runbook for the pre-merge verification plus the
resulting evidence.

## Why before merge

The Deno → Bun migration retires Deno Deploy and moves server hosting onto three Hetzner servers,
split by role. CI already proves the code builds and passes its gates in ephemeral runners; this plan
proves the things CI cannot: (1) the role-split scripts install a Bun runtime and start all three
server roles on real VMs; (2) the `workflow_dispatch` Hetzner workflows — which only run against a
live controller, not on PR CI — still work when they are the only deployment path left; and (3) the
scalability/performance gates and the cross-provider GitHub Free distributed recipe still hold under
the Bun runtime against a real deployed backend.

## Servers

| Server                      | id        | Role      | Runs                                                 |
| --------------------------- | --------- | --------- | ---------------------------------------------------- |
| `rallar-controller-fsn1-01` | 135672086 | `api`     | api-v1 (Bun) + Postgres + Caddy                      |
| `rallar-controller-02`      | 173949546 | `control` | control-server (Bun) + headless workers + Caddy      |
| `rallar-controller-03`      | 173949684 | `games`   | relic + ar-eye game servers (Bun) + Postgres + Caddy |

## Workflow coverage survey

The repo has 18 workflows. This section states which are already exercised automatically and which
this plan must run manually, so no gate is left out.

**Automatic on the PR (no manual step needed)** — `branch-release-gate.yml` runs on every PR and
calls, in turn: `governance-gate.yml`, `release-gate.yml` (unit, tooling, Bun, browser, recipe
console, and the API black-box recipes — standard 1/2, standard 2/2, cluster — plus the topology
replay proof), `games-release-gate.yml`, and `alm-conformance-observation.yml` (non-blocking). These
already run on PR #794 and cover the ephemeral-runner surface.

**Manual in this plan** — the `workflow_dispatch`-only and Hetzner workflows:

| Workflow                                      | Trigger              | Covered in       |
| --------------------------------------------- | -------------------- | ---------------- |
| `Deploy Hetzner Controller`                   | dispatch             | Phase 2 Step 2.1 |
| `Manage Hetzner Headless Browsers`            | dispatch             | Phase 2 Step 2.2 |
| `Run Hetzner Distributed Recipe`              | dispatch             | Phase 2 Step 2.3 |
| `Run Hetzner Supported Distributed Manifests` | push main / dispatch | Phase 2 Step 2.4 |
| `API v1 Medium-Scale Gate`                    | dispatch / PR paths  | Phase 2 Step 2.5 |
| `API v1 Formation Gate`                       | dispatch / PR paths  | Phase 2 Step 2.6 |
| `API v1 State-Write PR Measurement`           | label / dispatch     | Phase 2 Step 2.7 |
| `RTC-B05 / RTC-B06 Performance Observation`   | schedule / dispatch  | Phase 2 Step 2.8 |
| `Run GitHub Free Distributed Recipe`          | dispatch             | Phase 3          |

**Post-merge (no pre-merge action)** — `deploy.yml` ("Deploy Web + API") fires on `push` to `main`
and now contains only the (disabled) Cloudflare controls, the release gate, and the ALM conformance
observation — its Deno Deploy jobs are gone. It runs automatically when #794 merges.

**Optional / non-blocking extras** — `api-v1-black-box.yml` ("API v1 Black-Box") is a
`workflow_dispatch` re-run of the release-gate black-box lane (Postgres standard + cluster +
topology-replay) plus an optional pglite-memory backend. The Postgres/topology-replay part is already
covered automatically by `release-gate.yml`; only the `include_memory` backend is unique. Run it once
with `include_memory=true` for completeness if pglite-memory parity matters for the Bun build.

## Phase 1 — Install and verify the three roles on Hetzner

All roles use the controller scripts under `scripts/hosted-rallar/controller/`. On each VM, run as
`root`, with the role selected via `RALLAR_CONTROLLER_ROLE`.

### Step 1.1 — API role (fsn1-01)

```sh
# Copy the repo onto the VM and install Bun + Caddy + Postgres for the api role.
RALLAR_CONTROLLER_ROLE=api bash scripts/hosted-rallar/controller/01-install-runtime.sh
RALLAR_CONTROLLER_ROLE=api RALLAR_REPO_REF=claude/deno-to-bun-migration-plan \
  bash scripts/hosted-rallar/controller/02-deploy-controller.sh
```

Verify:

- `bun --version` prints `1.4.x`.
- `systemctl is-active rallar-api-v1.service` → `active`.
- `curl -fsS https://api.rallar.intactss.com/api/config` returns `200`.
- No `deno` binary or `deno.json` remains on the box (`command -v deno` empty).

### Step 1.2 — Control role (02)

```sh
RALLAR_CONTROLLER_ROLE=control bash scripts/hosted-rallar/controller/01-install-runtime.sh
RALLAR_CONTROLLER_ROLE=control RALLAR_REPO_REF=claude/deno-to-bun-migration-plan \
  bash scripts/hosted-rallar/controller/02-deploy-controller.sh
```

Verify:

- `systemctl is-active rallar-black-box-control.service` → `active`.
- The role does **not** provision Postgres (control has `HAS_POSTGRES=0`): `systemctl is-enabled postgresql` → `disabled`/absent.
- `curl -fsS https://control.rallar.intactss.com/` reaches the control server (CORS/handshake path).

### Step 1.3 — Games role (03)

```sh
RALLAR_CONTROLLER_ROLE=games bash scripts/hosted-rallar/controller/01-install-runtime.sh
RALLAR_CONTROLLER_ROLE=games RALLAR_REPO_REF=claude/deno-to-bun-migration-plan \
  bash scripts/hosted-rallar/controller/02-deploy-controller.sh
```

Verify:

- `systemctl is-active rallar-relic-hunter-server-v1.service` and
  `rallar-ar-eye-hunter-server-v1.service` → both `active`.
- `curl -fsS https://relic.rallar.intactss.com/api/config` and
  `https://ar-eye.rallar.intactss.com/api/config` → both `200`.
- Each game server has its own loopback `DATABASE_URL` and its migrations applied.

## Phase 2 — Run the Hetzner GitHub workflows against the branch

These are `workflow_dispatch` workflows. Dispatch each with `ref` = the branch tip
(`claude/deno-to-bun-migration-plan`), and record the run URL + result.

### Step 2.1 — Deploy Hetzner Controller (inspect, then rollout)

- `action=inspect`, `ref=<branch-tip>` → confirms the effective-env reader, public-settings validator,
  and `07-status-controller.sh --inspect` stream cleanly over SSH stdin; prints one JSON object.
- `action=rollout`, `ref=<branch-tip>`, `preserve_public_settings=true` → proves the controlled
  stop/update/start flow works with Bun: `npm ci`, Bun cache warm, SPA build, `bunx prisma migrate
  deploy`, Caddy reload, health checks.

### Step 2.2 — Manage Hetzner Headless Browsers

- `action=status` → reports the headless worker service state.
- `action=start`, `ref=<branch-tip>`, `agent_count=2`, `rollout_before_start=true` → proves the
  worker service starts Playwright/Chromium and registers connected agents.
- `action=stop` → cleans up.

### Step 2.3 — Run Hetzner Distributed Recipe

- `ref=<branch-tip>`, `rollout_before_run=false` (reuse the checkout), `agent_count=2` → runs one
  distributed recipe end-to-end against live agents and exports artifacts. Confirms the Bun control
  server accepts agent connections and the recipe matrix still passes.

### Step 2.4 — Run Hetzner Supported Distributed Manifests (main-branch gate shape)

The main-push gate (`hetzner-supported-distributed-manifests.yml`) runs the supported manifest set.
Since it fires on `push` to `main` and `workflow_dispatch`, dispatch it manually with the branch ref
to prove the same five manifests (`01-health`, `02-composite-evidence`, `03-rtc-smoke`,
`04-provider-parity`, `05a-rtc-realtime-stability`) pass on the Bun build before merge.

### Step 2.5 — API v1 Medium-Scale Gate

`api-v1-medium-scale-gate.yml` (also runs on PR CI). Dispatch with the branch ref to prove the Bun
runner executes the unchanged medium-scale profile against a live Postgres service container.

- `workflow_dispatch`, ref = branch tip.
- Confirms 100 independently authenticated clients / five groups / three Bun API processes pass.

### Step 2.6 — API v1 Formation Gate

`api-v1-formation-gate.yml`. Dispatch with the branch ref to prove the formation-large profile —
large-room group formation under the Bun server — still converges.

### Step 2.7 — API v1 State-Write PR Measurement (scalability / performance)

`api-v1-state-write-pr-measurement.yml` is the authoritative hosted state-write comparison gate. It
runs base vs candidate and fails on a regression. Dispatch with `ref` = the branch tip and `mode`
`comparison` (plus, separately, `mode=diagnostic` for the bounded-timeline view). This is the one
perf gate that must be read as blocking — a regression here is a merge blocker, not informational.

### Step 2.8 — RTC performance observations (B05 / B06)

- `rtc-performance-observation.yml` (RTC-B05) and `rtc-b06-performance-observation.yml` (RTC-B06)
  both fire on `workflow_dispatch` and use the Bun runtime. Dispatch each once to confirm the Bun
  benchmark/observation tooling still captures and publishes a valid observation.

### Step 2.9 — Local perf smoke (fast, pre-fleet)

Before spending hosted cycles, run the local perf entry points under Bun to catch obvious regressions:

```sh
npm run perf:api-v1:state-write          # API state-write concurrency benchmark
npm run perf:rtc-baseline -- --help      # RTC baseline CLI loads under Bun
npm run perf:rtc-topology:delivery-log -- --help
npm run perf:rtc-topology:replay-drain -- --help
```

## Phase 3 — Run GitHub Free Distributed Recipe against the real Hetzner backend

This is the high-fidelity distributed test: **GitHub-hosted headless browsers** (up to 50 agents)
driving a **real Bun control server + API deployed on Hetzner**, over the public `wss://`/`https://`
endpoints. It proves cross-provider agent→Hetzner connectivity and the Bun control plane under the
same topology the main-branch distributed gate uses.

Prerequisite: Phase 1 (all three roles) and Phase 2 Step 2.2 (headless workers) are already green, so
the control server on 02 and the API on fsn1-01 are live.

Dispatch `github-free-distributed-recipe.yml`:

```text
execution_mode: hetzner-control
manifest_path: apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json
target_agent_count: 50
agents_per_job: 3
max_parallel_jobs: 17
rollout_control_plane: preserve-public-settings
room_id: hetzner-headless-room
application_id: rallar-server
workspace_id: default
control_url: wss://control.rallar.intactss.com/control
control_http_url: https://control.rallar.intactss.com
api_base_url: https://api.rallar.intactss.com
spa_url: https://blackbox.rallar.intactss.com
register_before_login: true
```

Acceptance:

- All 50 GitHub-hosted agents connect to the Hetzner control server and complete the run.
- The distributed run reaches its terminal state with no group assertions failing.
- `analysis/performance.md` is produced and shows the expected principal-tree delivery profile.

## Phase 4 — Acceptance

Record evidence for each of these; the PR is not released to `main` until all are met:

1. All three roles report their services `active` and their public health endpoints `200`.
2. No `deno` binary, `deno.json`, or `deno.lock` exists on any VM checkout.
3. `Deploy Hetzner Controller` (inspect + rollout) and `Manage Hetzner Headless Browsers` (start +
   status) both succeed with `ref` = the branch tip.
4. `Run Hetzner Distributed Recipe` succeeds on the branch tip.
5. `Run Hetzner Supported Distributed Manifests` passes the supported manifest set.
6. **Scalability/performance gates pass**: `API v1 Medium-Scale Gate` and `API v1 Formation Gate`
   succeed, and `API v1 State-Write PR Measurement` (`comparison`) reports no regression.
7. **`Run GitHub Free Distributed Recipe` passes** against the real Hetzner backend (50 agents,
   `hetzner-control` mode).
8. No workflow log contains a `deno` invocation or a `Deno.*` runtime error.

## Main-only and cross-runtime items (run post-merge, not on the branch)

- `Run Hetzner Supported Distributed Manifests` has no `ref` input — it resolves `github.sha` and
  fires on `push` to `main`, so it is a post-merge gate, not a branch gate.
- `API v1 State-Write PR Measurement` `comparison` mode's own frozen-environment guard
  (`apps/api-v1/package.json` + `tsconfig.json` are new) refuses to A/B-compare a Deno base against
  a Bun candidate. The `diagnostic` mode proves the Bun state-write path produces a valid
  measurement, but a regression comparison across the runtime boundary is not meaningful.

## Follow-up (out of scope here)

- Deleting the three Deno Deploy apps and their Postgres databases (out-of-band; see PR #794 body).
- Wiring `RALLAR_CONTROLLER_ROLE` per-host into the deploy workflows via per-role `HETZNER_HOST_*`
  secrets — a separate follow-up PR, not this validation run. The distributed-recipe and headless
  workflows currently target a single `HETZNER_HOST` (fsn1-01) and run their workers there, which
  relies on cross-host DNS to reach the control server on 02.
- The pre-existing Postgres integration failures tracked in #797 and the flaky CRDT test in #795.
