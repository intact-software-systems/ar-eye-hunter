# Rallar Black-Box Hetzner Deployment Plan

This document plans a cost-focused Hetzner deployment for running
`apps/rallar-black-box` as headless browser agents against `apps/api-v1`.

The intent is to support multi-hour Rallar middleware and API-v1 performance
tests without paying for managed browser infrastructure or a managed database.

## Goal

Run short-lived Hetzner Cloud infrastructure for a few hours:

- one API-v1 controller stack using `RALLAR_SQL_BACKEND=pglite-memory`
- one Rallar black-box control server
- one served `rallar-black-box` SPA
- one or more headless browser-worker VMs that open the SPA in control-agent
  mode
- artifact export from the control server after each run
- explicit cleanup so idle VMs do not keep billing

Cost is the main optimization for this iteration. Reliability only needs to be
good enough for a few-hour test window.

## Non-Goals

- Do not use Deno Deploy, Cloudflare Workers, Vercel Edge, or other isolate
  platforms for `pglite-memory` or headless browsers.
- Do not use Browserbase, Browserless, or another managed browser provider for
  the first cost-focused iteration.
- Do not claim production Postgres performance from this mode.
- Do not scale API-v1 horizontally while `pglite-memory` is enabled.

## Recommended First Topology

Use a single x86 controller VM plus short-lived x86 worker VMs.

```text
Hetzner controller VM
  API-v1 memory mode      : http://127.0.0.1:8080
  black-box control server: http://127.0.0.1:5180
  black-box SPA           : http://127.0.0.1:5176 or static dist
  reverse proxy/TLS       : https://api.*, https://control.*, https://blackbox.*

Hetzner browser worker VM(s)
  Playwright/Chromium
  N browser contexts
  each context opens the SPA with mode=control and provider=browser-rallar
```

For the first pass, keep the controller and the first worker in the same Hetzner
region. Add other regions only after the one-region run is stable.

Prefer x86 workers initially. ARM can be cheaper, but Playwright and Chromium
are the expensive moving parts; verify x86 first, then add an ARM experiment if
cost pressure remains.

## Sizing Starting Point

Use current Hetzner prices at purchase time. Hetzner has announced price changes
around June 2026, so do not bake exact prices into automation.

Suggested starting sizes:

- Controller: 8 GB RAM shared CPU VM.
- Worker: 4 GB RAM shared CPU VM for 2 to 4 Chromium contexts.
- Larger worker: 8 GB RAM shared CPU VM for 6 to 8 Chromium contexts after
  measurement.

Rules of thumb:

- Keep at least 25 percent RAM headroom on browser workers.
- Treat 2 Chromium contexts per 4 GB worker as the first safe baseline.
- Increase contexts only after measuring RSS, CPU, WebSocket stability, and RTC
  delivery.
- Destroy workers after each run.
- Disable backups and snapshots unless the iteration explicitly needs them.
- Use a small persistent directory only for control-server artifacts.

## Controller Runtime Configuration

API-v1 memory mode:

```text
PORT=8080
CORS_ORIGINS=https://blackbox.example.test
RALLAR_API_BASE_URL=https://api.example.test
RALLAR_WS_BASE_URL=wss://api.example.test
RALLAR_SQL_BACKEND=pglite-memory
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=local
RALLAR_ICE_MODE=local
RALLAR_LOGIN_USER_RATE_LIMIT=100
```

Control server:

```text
PORT=5180
RALLAR_BLACK_BOX_ADMIN_TOKEN=<generated-token>
RALLAR_BLACK_BOX_REQUIRE_TLS=1
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://blackbox.example.test
RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS=api.example.test
RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS=api.example.test,control.example.test
RALLAR_BLACK_BOX_STORAGE_DIR=/var/lib/rallar-black-box-control
RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=50
```

For a public controller, add run tokens before the multi-worker iteration:

```text
RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1
```

The first smoke can be done behind a firewall or VPN without run tokens, but
public browser-worker control should use tokens.

## Browser Worker Shape

The current Playwright tests already know how to open `rallar-black-box` in
control-agent mode, but the repo still needs a standalone worker entrypoint for
cheap cloud agents.

The worker entrypoint should launch Chromium and open URLs shaped like:

```text
https://blackbox.example.test/?mode=control&provider=browser-rallar&autoConnect=1&tab=local-workbench&controlUrl=wss%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=<run-id>&agentId=<agent-id>&apiBaseUrl=https%3A%2F%2Fapi.example.test&roomId=<room-id>&actor=<actor>&sessionId=<agent-id>&transport=realtime&rallarUsername=<username>&rallarPassword=<password>&rallarLeaveRoomOnClose=0
```

The worker should read:

```text
RALLAR_BLACK_BOX_SPA_URL=https://blackbox.example.test
RALLAR_BLACK_BOX_CONTROL_URL=wss://control.example.test/control
RALLAR_API_BASE_URL=https://api.example.test
RALLAR_BLACK_BOX_RUN_ID=<run-id>
RALLAR_BLACK_BOX_AGENT_PREFIX=<region-or-worker-name>
RALLAR_BLACK_BOX_AGENT_COUNT=2
RALLAR_BLACK_BOX_ROOM_ID=<room-id>
RALLAR_BLACK_BOX_USERNAME=<fixture-user-or-pattern>
RALLAR_BLACK_BOX_PASSWORD=<fixture-password>
```

It should also support per-agent credentials once the test needs more than the
static API-v1 users.

## RTC Networking Note

`RALLAR_ICE_MODE=local` is fine for local and same-host smoke tests, but
cross-region WebRTC is likely to need real STUN/TURN.

Recommended sequencing:

1. Prove HTTP, auth, groups, WebSocket, and control orchestration with
   `RALLAR_ICE_MODE=local`.
2. For remote RTC validation, switch API-v1 to `RALLAR_ICE_MODE=metered` or add
   a cheaper STUN/TURN path before expecting cross-region RTC to pass.
3. Keep WebSocket/group performance tests separate from RTC networking tests so
   one missing ICE provider does not block the rest of the cheap iteration.

## Iteration 1: Worker Entrypoint

Status: completed on 2026-06-02.

Goal: create a reusable headless browser-worker command for cloud VMs.

Expected output:

- a Node/Playwright worker script or package command
- environment-driven agent count, run id, agent id prefix, room id, API URL,
  control URL, and credentials
- graceful `SIGINT` / `SIGTERM` handling
- health logging for registered agents and open browser contexts
- local dry-run against `localhost` API/control/SPA

Acceptance checks:

- one command launches one headless browser agent locally
- `GET /runs/<runId>` on the control server shows the agent registered
- stopping the worker closes the browser and marks the agent disconnected
- no Playwright test runner is required for a long-lived worker session

Completed notes:

- Added `apps/rallar-black-box/src/headless-worker-config.ts` as the
  environment-driven worker configuration and URL builder.
- Added `apps/rallar-black-box/scripts/headless-worker.ts` as a long-lived
  Playwright/Chromium worker entrypoint.
- Added `npm --workspace rallar-black-box run worker:headless`.
- The worker launches `RALLAR_BLACK_BOX_AGENT_COUNT` browser contexts, opens the
  SPA in `mode=control&provider=browser-rallar&autoConnect=1`, waits for each
  agent to register in the control-server run snapshot, and keeps the contexts
  alive until `SIGINT` or `SIGTERM`.
- The worker treats the control server as the readiness source of truth and only
  uses the Local Workbench UI as a short, best-effort confirmation. This is
  important for cloud workers because SPA copy/layout changes should not block a
  registered headless agent.
- The worker supports shared credentials through
  `RALLAR_BLACK_BOX_USERNAME/PASSWORD` and per-agent credentials through
  `RALLAR_BLACK_BOX_AGENT_<n>_USERNAME/PASSWORD`.
- The worker supports run token, report upload URL, stats interval, heartbeat
  interval, application/workspace ids, region/environment labels, `realtime` or
  `messages.rtc`, and optional register/restore-session flags.

Example local command:

```sh
RALLAR_BLACK_BOX_SPA_URL=http://localhost:5176 \
RALLAR_BLACK_BOX_CONTROL_URL=ws://127.0.0.1:5180/control \
RALLAR_API_BASE_URL=http://localhost:8080 \
RALLAR_BLACK_BOX_RUN_ID=hetzner-local-smoke \
RALLAR_BLACK_BOX_ROOM_ID=hetzner-local-room \
RALLAR_BLACK_BOX_AGENT_PREFIX=local-worker \
RALLAR_BLACK_BOX_AGENT_COUNT=1 \
RALLAR_BLACK_BOX_USERNAME=alice \
RALLAR_BLACK_BOX_PASSWORD=secret \
npm --workspace rallar-black-box run worker:headless
```

Verification:

- `npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- Local smoke passed with API-v1 `pglite-memory` on `18080`, control server on
  `5180`, and SPA on `5176`: one worker agent registered as `local-worker-01`,
  `GET /runs/hetzner-local-worker-smoke-3` showed `connected: true` and
  `status: configured`, and after `SIGTERM` the same run showed
  `connected: false`.

## Iteration 2: Controller VM Pilot

Goal: run the controller stack on one Hetzner VM.

Preflight:

- Complete `iterations/rallar-black-box-hetzner-iteration-2-readiness.md` before
  provisioning the controller VM.
- Use the controller install scripts under `scripts/hetzner/controller/` for the
  first Ubuntu 24.04 VM setup.
- Use `04-stop-controller.sh`, `05-start-controller.sh`,
  `06-restart-controller.sh`, and `07-status-controller.sh` for controller
  service lifecycle checks after deployment.

Expected output:

- VM provisioning notes or cloud-init script
- Node, npm, Deno, and Playwright dependencies installed
- API-v1 memory mode running on port `8080`
- control server running on port `5180`
- `rallar-black-box` SPA served over HTTPS
- reverse proxy routes for API, control, and SPA
- firewall exposing only SSH and HTTPS

Acceptance checks:

- `GET https://api.example.test/api/config` returns API and WS URLs that point
  to the public controller host
- `GET https://api.example.test/api/docs` returns HTML
- `GET https://control.example.test/health` returns the control-server health
  payload
- the SPA loads from `https://blackbox.example.test`
- controller memory remains stable for 30 minutes with no browser workers

## Iteration 3: Single Worker VM Pilot

Goal: connect real headless browsers from one Hetzner worker VM.

Expected output:

- one worker VM image or setup script
- Playwright browser dependencies installed
- worker command opens 1 to 2 browser agents
- control server receives agent heartbeats and stats

Acceptance checks:

- agents appear in the control-server run snapshot
- auth succeeds against API-v1
- group create/join/readback works
- WebSocket ticket and upgrade work
- a basic WebSocket message arrives
- worker CPU and memory are recorded

## Iteration 4: Cost And Concurrency Calibration

Goal: find the cheapest stable worker size and browser count.

Test matrix:

```text
4 GB worker, 1 browser
4 GB worker, 2 browsers
4 GB worker, 4 browsers
8 GB worker, 4 browsers
8 GB worker, 6 browsers
8 GB worker, 8 browsers
```

Expected output:

- one table with worker size, browser count, RAM use, CPU use, failures,
  messages/sec, and approximate cost per hour
- recommended default worker size and browser count
- upper limit where failures begin

Acceptance checks:

- selected default runs for at least 60 minutes
- no browser process is OOM-killed
- control-server heartbeat gaps stay within the expected threshold
- API-v1 memory stays below the selected controller headroom

## Iteration 5: Same-Region Multi-Worker Soak

Goal: run multiple workers in one region for a few hours.

Expected output:

- 2 to 4 worker VMs in the same region
- one shared controller VM
- one run id with all agents
- artifact export after completion
- cleanup script destroys all worker VMs

Acceptance checks:

- run lasts 2 to 3 hours
- no worker disappears unexpectedly
- control-server artifacts export successfully
- API-v1 does not exceed memory target
- queue rows do not get stuck in `RESERVED`
- no duplicate message delivery is observed for direct scenarios

## Iteration 6: Multi-Region WebSocket And Group Run

Goal: expand to Hetzner regions while avoiding RTC-specific ICE risk.

Expected output:

- one worker group in Europe
- one worker group in the United States
- optional Singapore worker group if budget allows
- WebSocket/group recipe or distributed-run manifest that does not require
  cross-region WebRTC

Acceptance checks:

- all region groups register with region-specific agent ids
- group membership, state sync, and WebSocket delivery work across workers
- artifacts include region labels
- latency report separates per-region and cross-region delivery

## Iteration 7: Remote RTC Path

Goal: make cross-region RTC testing explicit and separately budgeted.

Expected output:

- decision between Metered ICE, another TURN provider, or a self-hosted Coturn
  VM
- API-v1 env updated for remote ICE
- smallest three-region RTC run

Acceptance checks:

- three agents in at least two regions establish RTC readiness
- realtime direct, multicast, and broadcast pass
- `messages.rtc` direct, multicast, and broadcast pass
- ICE provider cost is recorded separately from Hetzner VM cost

## Iteration 8: Provisioning Automation

Goal: avoid manual setup and accidental spending.

Expected output:

- `hcloud` CLI or Terraform provisioning scripts
- cloud-init for controller and worker roles
- tagged resources such as `rallar-test=true`
- `destroy` command that deletes all workers for a run id
- optional budget guard that refuses to create more than the configured worker
  count

Acceptance checks:

- one command creates controller infrastructure
- one command creates N workers
- one command destroys workers
- failed provisioning does not leave untagged resources behind
- the generated inventory records VM id, region, public IP, role, run id, and
  creation time

## Iteration 9: Performance Report

Goal: turn the run into a useful product artifact.

Expected output:

- generated Markdown or JSON report per run
- browser count, worker count, regions, VM sizes, elapsed time
- API-v1 memory and CPU summary
- worker memory and CPU summary
- message throughput and p50/p95/p99 latency
- failures, retries, disconnects, and stuck queue rows
- total approximate VM cost

Acceptance checks:

- report can be generated from control-server artifacts plus worker logs
- report includes enough data to compare one run against another
- report explicitly labels memory-mode results as load-shape data, not
  production database tuning

## Iteration 10: Cheap Repeatable Runbook

Goal: document the final operator workflow.

Expected output:

- runbook for:
  - creating controller
  - creating workers
  - starting a run
  - watching live status
  - exporting artifacts
  - destroying workers
  - destroying controller
- troubleshooting section for:
  - browser worker OOM
  - control WebSocket disconnects
  - auth rate limits
  - missing CORS origins
  - RTC not ready
  - pglite-memory controller memory growth

Acceptance checks:

- a fresh machine can follow the runbook without repo-specific hidden state
- commands include all required environment variables
- cleanup is explicit and hard to miss

## Cost Guardrails

- Start with the smallest number of VMs that proves the path.
- Prefer shared CPU workers until CPU saturation is measured.
- Keep the controller in one region for `pglite-memory`.
- Destroy workers after every run.
- Do not enable backups for workers.
- Do not attach persistent volumes to workers.
- Use storage only for controller artifacts if needed.
- Record total runtime for every VM in the performance report.
- Verify Hetzner prices before each iteration, especially around announced
  pricing changes.

## Open Decisions

- Whether to serve the SPA from Vite preview, a static file server, or the same
  reverse proxy that fronts the controller.
- Whether to put API-v1 and the control server on one controller VM or split
  them after the first soak.
- Whether to require run tokens from the first public worker run or only after
  the pilot behind a firewall/VPN.
- Whether remote RTC should use Metered ICE, another managed TURN provider, or a
  self-hosted Coturn VM.
- Whether to add ARM worker experiments after the x86 baseline.

## References

- `docs/rallar-api-v1-in-memory-performance-mode.md`
- `apps/rallar-black-box/docs/api-v1-memory-mode-validation.md`
- `apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md`
- Hetzner Cloud pricing and product updates:
  <https://docs.hetzner.cloud/whats-new>
- Hetzner price adjustment reference:
  <https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/>
