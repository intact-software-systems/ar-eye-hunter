# Deno → Bun branch verification plan

Validation gate that runs **before** `claude/deno-to-bun-migration-plan` (PR #794) merges to `main`.
It proves the Bun build behaves on the real Hetzner fleet and that the re-wired GitHub workflows still
deploy, smoke, and run distributed recipes correctly. It changes no product code — it is the runbook
for the pre-merge verification plus the resulting evidence.

## Why before merge

The Deno → Bun migration retires Deno Deploy and moves server hosting onto three Hetzner servers,
split by role. CI already proves the code builds and passes its gates in ephemeral runners; this plan
proves the two things CI cannot: (1) the role-split scripts install a Bun runtime and start all three
server roles on real VMs, and (2) the `workflow_dispatch` Hetzner workflows — which only run against a
live controller, not on PR CI — still work when they are the only deployment path left.

## Servers

| Server | id | Role | Runs |
| --- | --- | --- | --- |
| `rallar-controller-fsn1-01` | 135672086 | `api` | api-v1 (Bun) + Postgres + Caddy |
| `rallar-controller-02` | 173949546 | `control` | control-server (Bun) + headless workers + Caddy |
| `rallar-controller-03` | 173949684 | `games` | relic + ar-eye game servers (Bun) + Postgres + Caddy |

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

## Phase 3 — Acceptance

Record evidence for each of these; the PR is not released to `main` until all are met:

1. All three roles report their services `active` and their public health endpoints `200`.
2. No `deno` binary, `deno.json`, or `deno.lock` exists on any VM checkout.
3. `Deploy Hetzner Controller` (inspect + rollout) and `Manage Hetzner Headless Browsers` (start +
   status) both succeed with `ref` = the branch tip.
4. `Run Hetzner Distributed Recipe` succeeds on the branch tip.
5. `Run Hetzner Supported Distributed Manifests` passes the supported manifest set.
6. No workflow log contains a `deno` invocation or a `Deno.*` runtime error.

## Follow-up (out of scope here)

- Deleting the three Deno Deploy apps and their Postgres databases (out-of-band; see PR #794 body).
- Wiring `RALLAR_CONTROLLER_ROLE` per-host into the deploy workflows via per-role `HETZNER_HOST_*`
  secrets — a separate follow-up PR, not this validation run.
- The pre-existing Postgres integration failures tracked in #797 and the flaky CRDT test in #795.
