# Rallar Hetzner Controller Scripts

These scripts configure the Iteration 2 controller VM on Ubuntu 24.04 LTS.

Run them as `root` on `rallar-controller-fsn1-01`.

## Copy Scripts To The VM

From your local machine:

```sh
ssh root@api.rallar.intactss.com 'rm -rf ~/rallar-controller && mkdir -p ~/rallar-controller'
scp -r scripts/hetzner/controller/. root@api.rallar.intactss.com:~/rallar-controller/
```

Then SSH to the VM:

```sh
ssh root@api.rallar.intactss.com
cd ~/rallar-controller
chmod +x *.sh
ln -sf ~/rallar-controller/15-logs.sh /usr/local/bin/rallar-logs
```

## Run Order

Install base runtime dependencies:

```sh
./01-install-runtime.sh
```

Deploy the repo, configure env files, install systemd units, build the SPA, and
configure Caddy:

```sh
./02-deploy-controller.sh
```

Enable Metered TURN for production WebRTC without putting the API key in Git or
shell history:

```sh
./13-configure-metered-turn.sh
```

The script prompts for `METERED_APP_NAME` and a silent `METERED_API_KEY`, writes
`/etc/rallar/api-v1.secrets.env` as a root-only `0600` file, installs a systemd
drop-in for `rallar-api-v1.service`, reloads systemd, and restarts API-v1.
`02-deploy-controller.sh` also references this optional secret file so future
redeploys keep Metered enabled when the file exists.

Run public smoke checks:

```sh
./03-smoke-controller.sh
```

Run a distributed recipe manifest against connected headless browsers and export
artifacts:

```sh
RALLAR_DISTRIBUTED_MANIFEST_PATH=/tmp/manifest.json \
RALLAR_DISTRIBUTED_CONTROL_RUN_ID="${RALLAR_BLACK_BOX_RUN_ID}" \
./14-run-distributed-recipe.sh
```

The manifest supplied to `14-run-distributed-recipe.sh` must already be the
workflow's materialized run manifest. Its distributed/control run identifiers
and top-level group must exactly match the worker environment. The runner
rejects a mismatch before creating a distributed run.

The supported workflow does not reset the database between recipes. Spawned
Hetzner runs with no explicit `room_id` receive a deterministic group unique to
the GitHub workflow run attempt; all worker and executable manifest identities
are rebound to it before upload. An explicit room remains stable, while
external, mixed, and no-spawn runs preserve the checked-in manifest group.
Completed groups are retained for normal server expiry and diagnostics.
Preservation includes the application and workspace. Split topology
prepare/run operations compare the stable source-manifest hash rather than the
run-specific materialized-manifest hash.

Stop the Rallar API/control services:

```sh
./04-stop-controller.sh
```

Start them again:

```sh
./05-start-controller.sh
```

Restart them:

```sh
./06-restart-controller.sh
```

Show service status, memory, and recent logs:

```sh
./07-status-controller.sh
```

Tail app and headless browser logs from anywhere on the VM:

```sh
rallar-logs
rallar-logs -f
rallar-logs --browser -f
rallar-logs --services api,control,caddy --since "30 min ago"
rallar-logs --grep rtc-realtime --follow --pager
```

`rallar-logs` reads systemd journals for the Rallar API, control server,
headless browser worker, and Caddy. Browser logs come from the headless worker;
by default the worker logs browser warnings, errors, and page errors. Set
`RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL=info` or `debug` before starting workers to
capture more console output. Debug mode also logs failed browser requests.

Roll out the latest version from Git using a controlled stop/update/start flow:

```sh
./08-rollout-controller.sh
```

Start headless browser workers on the controller VM:

```sh
RALLAR_BLACK_BOX_AGENT_COUNT=2 \
RALLAR_BLACK_BOX_USERNAME=<user> \
RALLAR_BLACK_BOX_PASSWORD=<password> \
./09-start-headless-workers.sh
```

Stop, restart, or inspect headless browser workers:

```sh
./10-stop-headless-workers.sh
./11-restart-headless-workers.sh
./12-status-headless-workers.sh
```

By default, the stop/start/restart scripts manage only:

```text
rallar-api-v1.service
rallar-black-box-control.service
```

Caddy is left running so HTTPS/static SPA stays available. To include Caddy:

```sh
RALLAR_INCLUDE_CADDY=1 ./04-stop-controller.sh
RALLAR_INCLUDE_CADDY=1 ./05-start-controller.sh
RALLAR_INCLUDE_CADDY=1 ./06-restart-controller.sh
RALLAR_INCLUDE_CADDY=1 ./08-rollout-controller.sh
```

Important: these scripts stop or start services on the VM. They do not stop
Hetzner billing. Delete the VM if you want billing to stop.

Also note that API-v1 uses the `prod-in-memory` profile; stopping or restarting
`rallar-api-v1.service` resets API-v1 in-memory data. Control-server snapshots
are persisted under `/var/lib/rallar-black-box-control`.

The default controller deployment uses in-memory SQL and local ICE unless
Metered TURN is configured. Do not treat it as the hardened `prod` profile. For
production, follow the exact selector and platform-secret guardrails in
[`docs/production-env-hardening-checklist.md`](../../../docs/production-env-hardening-checklist.md).

## Controlled Rollout

`08-rollout-controller.sh` is intended for routine upgrades after the initial
deploy has already installed system packages, env files, systemd units, Caddy,
and the checkout.

It performs:

```text
1. Verify root, required commands, and a clean git checkout.
2. Fetch origin and fast-forward pull RALLAR_REPO_REF, default main.
3. Run npm ci.
4. Warm Deno caches for API-v1 and the control server.
5. Build the rallar-black-box SPA with public `VITE_RALLAR_*` defaults.
6. Stop rallar-api-v1.service and rallar-black-box-control.service.
7. Publish static SPA files to /var/www/rallar-black-box.
8. Write `/etc/rallar/black-box-spa.env` as a non-secret audit file.
9. Refresh API-v1 and control-server browser origin policy.
10. Refresh Caddy reverse-proxy config, start API/control services, reload Caddy,
    and run local/public health checks.
11. Print service status and recent logs.
```

The script uses `git pull --ff-only`; it does not force-reset the checkout. If
the VM checkout has local changes, it aborts before changing the running
version. If the update, dependency install, cache warmup, or SPA build fails,
the services remain running on the previous process. If failure happens after
the services are stopped, the script attempts to start them again.

Override the branch/ref:

```sh
RALLAR_REPO_REF=my-branch ./08-rollout-controller.sh
```

Override the API CORS origins written during rollout:

```sh
RALLAR_API_CORS_ORIGINS=https://app.example.test,https://admin.example.test ./08-rollout-controller.sh
```

The rollout also keeps the public `RALLAR_BLACK_BOX_SPA_URL` origin allowed in
both API-v1 CORS and `rallar-black-box-control-server` browser-origin policy.
If you provide custom `RALLAR_API_CORS_ORIGINS`, the SPA origin is appended so
headless browser login, API calls, and control-server orchestration still work.

Override the control-server browser origins written during rollout:

```sh
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://blackbox.example.test ./08-rollout-controller.sh
```

The SPA origin is appended here too. After restart, rollout checks the public
control health endpoint with the SPA `Origin` header. A browser console CORS
error against `https://control.../distributed-runs/...` can still be a hidden
upstream failure: if Caddy returns `502 Bad Gateway` without reaching the
control server, Chrome reports the missing CORS header. Deploys and rollouts
install a Caddy error handler that adds the SPA CORS header to control upstream
failures so the browser can show the real 502, and rollout fails if public
control health is not reachable with the expected CORS header.

Run public smoke checks:

```sh
./03-smoke-controller.sh
```

If credentials are provided, the smoke script also verifies login, CORS headers,
WS ticket creation, and the public `wss://.../api/ws/{sessionId}` upgrade:

```sh
RALLAR_SMOKE_USERNAME=alice RALLAR_SMOKE_PASSWORD=secret ./03-smoke-controller.sh
```

Override the checkout path:

```sh
RALLAR_CHECKOUT_DIR=/opt/rallar/ar-eye-hunter ./08-rollout-controller.sh
```

Install Playwright Chromium/dependencies during rollout if needed:

```sh
RALLAR_INSTALL_PLAYWRIGHT=1 ./08-rollout-controller.sh
```

Playwright installs are lock-aware. The shared installer checks required Linux
packages without refreshing apt when they are already present. A missing
package is installed through an Ubuntu-only apt profile, so NodeSource and
Caddy cannot break browser preparation. Browser binaries are installed into a
versioned candidate under `/var/lib/rallar-playwright/versions`, launched once
as `rallar`, and only then switched through
`/var/lib/rallar-playwright/active`. A failed dependency, download, or launch
leaves the active browser unchanged. Stale `__dirlock` files are removed only
after `RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS` seconds (`600` by default). For a
distributed-recipe repair without app redeploy, dispatch with
`rollout_before_run=false`, `install_playwright=true`, and `npm_ci=false`.

The deployed SPA receives its default API/control/room values at build time.
`02-deploy-controller.sh` and `08-rollout-controller.sh` derive these public
values and inject the matching Vite variables:

```text
RALLAR_API_BASE_URL=https://api.rallar.intactss.com
RALLAR_BLACK_BOX_CONTROL_URL=wss://control.rallar.intactss.com/control
RALLAR_BLACK_BOX_ROOM_ID=hetzner-headless-room
RALLAR_BLACK_BOX_AGENT_PREFIX=controller
RALLAR_BLACK_BOX_AGENT_COUNT=1

VITE_RALLAR_PROVIDER=browser-rallar
VITE_RALLAR_API_BASE_URL=$RALLAR_API_BASE_URL
VITE_RALLAR_CONTROL_URL=$RALLAR_BLACK_BOX_CONTROL_URL
VITE_RALLAR_ROOM_ID=$RALLAR_BLACK_BOX_ROOM_ID
VITE_RALLAR_RUNNER_AGENT_PREFIX=$RALLAR_BLACK_BOX_AGENT_PREFIX
VITE_RALLAR_RUNNER_AGENT_COUNT=$RALLAR_BLACK_BOX_AGENT_COUNT
```

The audit file `/etc/rallar/black-box-spa.env` records the public values used
for the last SPA build. Changing these values requires another deploy or
rollout because Vite embeds them into the static bundle.

Keep `/etc/rallar/black-box-spa.env` non-secret. The black-box SPA exposes only
`VITE_*` values to the browser bundle; server-only `RALLAR_*` secrets belong in
systemd env files or root-only secret files, not in SPA build inputs.

## Headless Browser Workers

`09-start-headless-workers.sh` creates or updates:

```text
/etc/rallar/headless-worker.env
/etc/systemd/system/rallar-black-box-headless-worker.service
```

The service runs:

```sh
npm --workspace rallar-black-box run worker:headless
```

It starts one Node/Playwright worker process. That worker opens
`RALLAR_BLACK_BOX_AGENT_COUNT` Chromium contexts and keeps them connected until
the service is stopped.

Default public endpoints:

```text
RALLAR_BLACK_BOX_SPA_URL=https://blackbox.rallar.intactss.com
RALLAR_BLACK_BOX_CONTROL_URL=wss://control.rallar.intactss.com/control
RALLAR_API_BASE_URL=https://api.rallar.intactss.com
RALLAR_BLACK_BOX_ROOM_ID=hetzner-headless-room
RALLAR_BLACK_BOX_AGENT_PREFIX=controller
RALLAR_BLACK_BOX_AGENT_COUNT=1
```

These values in `/etc/rallar/headless-worker.env` control the actual headless
worker service. The SPA build uses the same prefix/count only as initial UI
defaults for the Recipes “Connect Agents” controls.

Start two browser agents:

```sh
RALLAR_BLACK_BOX_RUN_ID=manual-$(date -u +%Y%m%dT%H%M%SZ) \
RALLAR_BLACK_BOX_ROOM_ID=manual-room \
RALLAR_BLACK_BOX_AGENT_PREFIX=controller \
RALLAR_BLACK_BOX_AGENT_COUNT=2 \
RALLAR_BLACK_BOX_USERNAME=<user> \
RALLAR_BLACK_BOX_PASSWORD=<password> \
RALLAR_INSTALL_PLAYWRIGHT=1 \
./09-start-headless-workers.sh
```

### External GitHub Agent Pools

When browser workers are started outside the VM, the operator can wait for
those control agents without touching the Hetzner systemd worker service:

```sh
RALLAR_BLACK_BOX_CONTROL_URL=wss://control.rallar.intactss.com/control \
RALLAR_BLACK_BOX_RUN_ID=gh-123 \
RALLAR_BLACK_BOX_AGENT_PREFIX=controller \
RALLAR_BLACK_BOX_AGENT_COUNT=50 \
RALLAR_BLACK_BOX_AGENT_START_INDEX=1 \
RALLAR_HEADLESS_READY_TIMEOUT_SECONDS=240 \
./16-wait-for-control-agents.sh
```

Headless browser login uses the same visible Rallar Kit login flow as a human
browser. The worker opens the public SPA with `provider=browser-rallar`,
`rallarUsername`, `rallarPassword`, `apiBaseUrl`, `applicationId`,
`workspaceId`, `roomId`, `runId`, and `agentId` in the bootstrap query string.
The SPA pre-fills the login form from those values, the worker clicks `Sign in`,
and only after a real browser auth session exists does the SPA connect to the
control WebSocket as a remote agent. If login or CORS fails, the agent never
appears as connected and the start script times out while printing recent
service logs.

Use `RALLAR_BLACK_BOX_REGISTER=1`, or the GitHub Actions
`register_before_login` input, when the target API is memory-backed and has just
been redeployed so the disposable test user must be created before login. Leave
it disabled for pre-provisioned or persistent auth users. When registration
reports that the user already exists, the black-box auth flow falls back to a
normal login with the same credentials.

The `scripts/hetzner/dispatch-distributed-recipe.sh` helper defaults
`register_before_login=true` for Hetzner runs because the current controller API
uses memory-backed auth. Pass `--register-before-login false` only when running
against a persistent user database.

The GitHub Actions headless browser workflow resolves credentials for
`action=start` in this order:

```text
1. Workflow inputs rallar_black_box_username/rallar_black_box_password
2. Production secrets RALLAR_BLACK_BOX_USERNAME/RALLAR_BLACK_BOX_PASSWORD
3. Early failure before SSH, rollout, or service restarts
```

Prefer production secrets for long-lived credentials. The workflow inputs are
useful for temporary runs, but GitHub workflow inputs are not repository
secrets.

If `RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1` is enabled on the control server,
the GitHub Actions headless browser workflow mints per-agent run tokens for
`action=start` and `action=restart` before copying the remote worker env. For
direct script usage, pass per-agent run tokens to the headless worker rather
than a permanent admin token:

```sh
RALLAR_BLACK_BOX_AGENT_1_CONTROL_TOKEN=<issued-run-token-for-local-agent-1>
RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN=<issued-run-token-for-local-agent-2>
```

If `RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN=1` is enabled, also pass an
admin/operator token for Node-side control-server reads:

```sh
RALLAR_BLACK_BOX_CONTROL_READ_TOKEN=<admin-or-operator-token>
```

Useful options:

```text
RALLAR_INSTALL_PLAYWRIGHT=1
  Install Chromium Linux dependencies as root and the Chromium browser cache as
  the rallar user before starting.

RALLAR_NPM_CI=1
  Run npm ci before starting.

RALLAR_WAIT_FOR_HEADLESS_WORKERS=0
  Start the service without waiting for control-server registration.

RALLAR_HEADLESS_READY_TIMEOUT_SECONDS=120
  Increase the registration wait timeout.

RALLAR_WRITE_HEADLESS_ENV=0
  Reuse the existing /etc/rallar/headless-worker.env instead of rewriting it.
```

## TURN / STUN Readiness

API-v1 selects `RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory`. That profile
owns local ICE and intentionally returns
`iceServers: []` from `/api/webrtc/ice`. The Rallar black-box Recipes UI shows
this as a warning because local/LAN testing can still work, but cross-region
WebRTC may fail without TURN.

For production cross-region RTC tests, configure Metered TURN:

```sh
./13-configure-metered-turn.sh
./06-restart-controller.sh
```

In GitHub Actions, set both optional secrets `METERED_APP_NAME` and
`METERED_API_KEY`; the deploy workflow syncs them before rollout. Leaving both
unset keeps any existing VM secret file in place.

## Controller Configuration Profile

The controller scripts own one disposable deployment shape:

```text
RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory
```

`02-deploy-controller.sh` writes that selector plus only controller-specific
URLs, CORS, workload limits, topology experiment overrides, and API secrets.
`08-rollout-controller.sh` removes entries outside that subset before updating
the selected ref. Both keep `/etc/rallar/api-v1.env` root-owned and mode `0600`.
There is no environment-name selector or repeated database/auth/ICE baseline.

Do not convert this disposable controller into the hardened public API-v1 or
Relic deployment by accumulating overrides. Those targets select the `prod`
profile and use the platform settings in the
[Production Environment Hardening Checklist](../../../docs/production-env-hardening-checklist.md).
Never put `DATABASE_URL`, `METERED_API_KEY`, `RALLAR_BLACK_BOX_ADMIN_TOKEN`, or
operator-token secrets into the SPA audit file or any `VITE_*` input.

Stop browsers:

```sh
./10-stop-headless-workers.sh
```

Restart using the existing env file:

```sh
./11-restart-headless-workers.sh
```

Inspect status, memory, connected agents, and recent logs:

```sh
./12-status-headless-workers.sh
```

Suppress recent logs:

```sh
RALLAR_HEADLESS_LOG_LINES=0 ./12-status-headless-workers.sh
```

The headless browser service is separate from the controller API/control
services. Stopping `rallar-black-box-headless-worker.service` closes browser
contexts but does not stop API-v1, the control server, or Caddy.

## GitHub Action: Controller Deploy

The workflow `.github/workflows/deploy-hetzner-controller.yml` exposes a manual
`workflow_dispatch` action named `Deploy Hetzner Controller`.

Use it from GitHub:

```text
Actions
Deploy Hetzner Controller
Run workflow
```

The deploy action runs `08-rollout-controller.sh` on the VM. It updates the
repo checkout, builds the static `rallar-black-box` SPA, publishes it under
Caddy, restarts API/control, and writes `/etc/rallar/black-box-spa.env` with
the public values baked into the bundle.

Required GitHub secrets:

```text
HETZNER_HOST
HETZNER_USER
HETZNER_SSH_PRIVATE_KEY
HETZNER_KNOWN_HOSTS
```

Optional Metered TURN GitHub secrets:

```text
METERED_APP_NAME
METERED_API_KEY
```

Workflow inputs:

```text
ref
  Git ref to roll out. Default: main.

include_caddy
  Also stop/start Caddy during rollout. Default: false.

install_playwright
  Install/update Chromium and Linux dependencies during rollout. Default: false.

spa_url
  Public black-box SPA URL recorded in the SPA audit file.
  Default: https://blackbox.rallar.intactss.com

control_url
  Public black-box control WebSocket URL baked into the SPA Recipes UI.
  Default: wss://control.rallar.intactss.com/control

api_base_url
  Public API-v1 base URL baked into the SPA.
  Default: https://api.rallar.intactss.com

api_cors_origins
  Optional API-v1 CORS origins. The SPA origin is appended automatically.
  Default: empty.

control_cors_origins
  Optional control-server browser origins. The SPA origin is appended
  automatically.
  Default: empty.

room_id
  Default Rallar room/group id shown in Global Context and Recipes.
  Default: hetzner-headless-room

runner_agent_prefix
  Default prefix for the Recipes “Open agent tabs” UI.
  Default: controller

runner_agent_count
  Default number of browser agent tabs suggested by the Recipes UI.
  Default: 1

application_id
  Default Rallar application id baked into the SPA.
  Default: rallar-server

workspace_id
  Default Rallar workspace id baked into the SPA.
  Default: default
```

The deploy action forwards these public inputs to the remote rollout as:

```text
RALLAR_BLACK_BOX_SPA_URL
RALLAR_BLACK_BOX_CONTROL_URL
RALLAR_API_BASE_URL
RALLAR_API_CORS_ORIGINS
RALLAR_BLACK_BOX_ALLOWED_ORIGINS
RALLAR_BLACK_BOX_ROOM_ID
RALLAR_BLACK_BOX_AGENT_PREFIX
RALLAR_BLACK_BOX_AGENT_COUNT
RALLAR_BLACK_BOX_APPLICATION_ID
RALLAR_BLACK_BOX_WORKSPACE_ID
```

`08-rollout-controller.sh` then maps them to the Vite build-time variables
used by the SPA:

```text
VITE_RALLAR_PROVIDER=browser-rallar
VITE_RALLAR_API_BASE_URL=$RALLAR_API_BASE_URL
VITE_RALLAR_CONTROL_URL=$RALLAR_BLACK_BOX_CONTROL_URL
VITE_RALLAR_ROOM_ID=$RALLAR_BLACK_BOX_ROOM_ID
VITE_RALLAR_RUNNER_AGENT_PREFIX=$RALLAR_BLACK_BOX_AGENT_PREFIX
VITE_RALLAR_RUNNER_AGENT_COUNT=$RALLAR_BLACK_BOX_AGENT_COUNT
VITE_RALLAR_APPLICATION_ID=$RALLAR_BLACK_BOX_APPLICATION_ID
VITE_RALLAR_WORKSPACE_ID=$RALLAR_BLACK_BOX_WORKSPACE_ID
```

Example production deploy values:

```text
ref: main
spa_url: https://blackbox.rallar.intactss.com
control_url: wss://control.rallar.intactss.com/control
api_base_url: https://api.rallar.intactss.com
room_id: hetzner-headless-room
runner_agent_prefix: controller
runner_agent_count: 1
application_id: rallar-server
workspace_id: default
```

After the action succeeds, open:

```text
https://blackbox.rallar.intactss.com/?workspace=black-box-runner
```

The Recipes tab should default to the configured API/control/room values. To
audit what was built, SSH to the VM and inspect:

```sh
cat /etc/rallar/black-box-spa.env
```

When both Metered secrets are set, the workflow syncs them into
`/etc/rallar/api-v1.secrets.env` on the VM before rollout. When both are absent,
the workflow leaves the VM untouched and keeps reusing the existing secret file
if one is already present. If only one Metered secret is set, the workflow fails
before rollout so it does not overwrite a working TURN setup with partial
credentials.

If the Recipes tab warns that no TURN/STUN servers were returned, set both
`METERED_APP_NAME` and `METERED_API_KEY` as GitHub secrets and rerun `Deploy
Hetzner Controller`. The workflow syncs Metered TURN before rollout; API-v1 will
restart as part of the rollout and `/api/webrtc/ice` should then return
non-empty ICE servers.

The deploy action only configures the SPA defaults. It does not start or resize
headless browsers. Use the `Manage Hetzner Headless Browsers` action below for
the actual worker service.

## GitHub Action: Headless Browsers

The workflow `.github/workflows/hetzner-headless-browsers.yml` exposes a manual
`workflow_dispatch` action named `Manage Hetzner Headless Browsers`.

Supported actions:

```text
start
stop
restart
status
```

For `start`, configure:

```text
ref
rollout_before_start
include_caddy
agent_count
run_id
room_id
agent_prefix
spa_url
control_url
api_base_url
api_cors_origins
control_cors_origins
application_id
workspace_id
rallar_black_box_username
rallar_black_box_password
register_before_login
install_playwright
npm_ci
wait_for_agents
ready_timeout_seconds
```

Required GitHub secrets for remote access:

```text
HETZNER_HOST
HETZNER_USER
HETZNER_SSH_PRIVATE_KEY
HETZNER_KNOWN_HOSTS
```

Fallback GitHub secrets for `action=start` credentials:

```text
RALLAR_BLACK_BOX_USERNAME
RALLAR_BLACK_BOX_PASSWORD
```

`RALLAR_BLACK_BOX_USERNAME` and `RALLAR_BLACK_BOX_PASSWORD` are optional when
the dispatch inputs `rallar_black_box_username` and `rallar_black_box_password`
are provided for the run. For `action=start`, the workflow fails before opening
SSH if neither inputs nor production secrets provide both values.

Optional GitHub secrets when control-server hardening is enabled:

```text
RALLAR_BLACK_BOX_CONTROL_READ_TOKEN
RALLAR_BLACK_BOX_CONTROL_TOKEN
```

Prefer `RALLAR_BLACK_BOX_CONTROL_READ_TOKEN` for the admin/operator token used
by GitHub workflows to mint short-lived per-agent run tokens and poll protected
read endpoints. `RALLAR_BLACK_BOX_CONTROL_TOKEN` remains a legacy fallback for
older deployments.

For `action=start` and `action=restart`, the headless browser workflow appends
`RALLAR_BLACK_BOX_AGENT_<N>_CONTROL_TOKEN` values to the remote worker env. When
the `run_id` input is blank, the workflow generates a stable run id before token
minting so the issued tokens match the worker registration run.

For normal browser operation, do not paste the permanent
`RALLAR_BLACK_BOX_ADMIN_TOKEN` into public Black Box URLs. The Recipes tab now
requests a short-lived operator token from API-v1 when the operator is logged
in, the manual Control Token field is empty, and a distributed recipe is
started. The brokered token is kept in browser memory only and defaults to 24
hours.

Use `action=start` with the desired `agent_count` to launch browsers. Use
`action=stop` to stop them. Use `action=status` to inspect the current service
and connected agents.

By default `action=start` and `action=restart` first stop the existing headless
worker service, run `08-rollout-controller.sh` for the selected `ref`, refresh
API/control CORS policy from the public SPA URL, and then start the headless
worker service. Set `rollout_before_start=false` when you only want to reuse the
already-deployed checkout and restart browsers from the existing VM files.

Use the optional `control_cors_origins` input only when you need additional
browser origins for the control server. The workflow always appends `spa_url`
automatically so `https://blackbox.rallar.intactss.com` can call the control
HTTP API after frequent headless browser rollouts.

## GitHub Action: Distributed Recipe

The workflow `.github/workflows/hetzner-distributed-recipe.yml` exposes a
manual action named `Run Hetzner Distributed Recipe`. It delegates the actual
Hetzner work to the reusable
`.github/workflows/hetzner-distributed-recipe-runner.yml` workflow.

The workflow `.github/workflows/hetzner-supported-distributed-manifests.yml`
runs on every push to `main` and can also be triggered manually. It queues every
commit, prepares and verifies the exact commit once, then runs the manifest
matrix serially without repeating rollout, npm installation, or Playwright
installation. The preparation job writes
`/var/lib/rallar-black-box-control/deployment-readiness.json`; every run-only
Hetzner phase rejects a stale commit, lockfile, Playwright version, browser,
operating system, or service-health value. The supported green set is:

- `01-health-2-agent.json`
- `02-composite-evidence-2-agent.json`
- `03-rtc-smoke-2-agent.json`
- `04-provider-parity-2-agent.json`
- `05a-rtc-realtime-stability-2-agent-5s.json`

The `05-rtc-realtime-2-agent-5s.json` and
`06-rtc-realtime-3-agent-15s.json` manifests remain generated and valid, but
they are extended/manual RTC follow-up runs rather than the main-branch green
gate.

It copies a checked-in distributed manifest to the VM, optionally runs
`08-rollout-controller.sh`, starts headless browsers with
`09-start-headless-workers.sh`, runs `14-run-distributed-recipe.sh`, copies
artifacts back to GitHub, runs
`apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts`, and
uploads both raw artifacts and analysis.

Use `manifest_path` for the repo-relative distributed manifest file. Leave
`run_id` blank to derive a unique control run id from the GitHub run. The
workflow sets the distributed `controlRunId` to the same value so target
resolution uses the newly connected headless agents.

Use `control_url` and `control_http_url` to point the workflow at a staging
control server or another public Hetzner control plane. The reusable runner
forwards them to the remote `RALLAR_BLACK_BOX_CONTROL_URL` and
`RALLAR_CONTROL_HTTP_URL` values used by the headless workers and
distributed-run admin calls.

Every remote operation writes a **Hetzner operation diagnostics** table to the
GitHub job summary and uploads
`hetzner-operation-<distributed-run-id>`. Start there; it contains
`operation-report.json`, `summary.md`, and a bounded sanitized `evidence.log`.
The report states whether the recipe started, the failing stage and component,
the exit code, artifact availability, and the next human action. It is always
created, including preparation, SSH, browser, or service failures that happen
before distributed artifacts exist. No AI analysis is required to distinguish
those failures.

If `recipeStarted` is `true`, continue with `analysis/fix-proposal.md` for a
failed recipe or `analysis/performance.md` for a passed run. If it is `false`,
the missing distributed artifact is expected; use the operation report rather
than requesting an analyzer rerun.

Already-running global-fleet agents use a separate no-spawn flow. Do not use
the Hetzner lifecycle workflow when the browsers are already running around the
world. Use manifests under `apps/rallar-black-box/manifests/world-fleet` and
run:

```bash
npx tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts \
  --control http://127.0.0.1:5180 \
  --manifest apps/rallar-black-box/manifests/world-fleet/01-rtc-messages-principal-50-agent-30s-20hz-tree.json \
  --control-run-id live-world-fleet-control-run \
  --token "$RALLAR_CONTROL_ADMIN_TOKEN"
```

That script only preflights, creates, stages, starts, polls, and exports
artifacts against an existing control server. Use `--control-run-id` or
`RALLAR_CONTROL_RUN_ID` when the connected agents are registered under a live
control run ID rather than the template ID in the checked-in manifest.

## Defaults

The deploy script defaults to:

```text
RALLAR_REPO_URL=https://github.com/intact-software-systems/ar-eye-hunter.git
RALLAR_REPO_REF=main
RALLAR_CHECKOUT_DIR=/opt/rallar/ar-eye-hunter
RALLAR_API_HOST=api.rallar.intactss.com
RALLAR_CONTROL_HOST=control.rallar.intactss.com
RALLAR_BLACKBOX_HOST=blackbox.rallar.intactss.com
RALLAR_API_CORS_ORIGINS=https://blackbox.rallar.intactss.com,https://ar-eye-hunter.pages.dev,https://relic-hunters-v1.intact-software-systems.workers.dev
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://blackbox.rallar.intactss.com
RALLAR_CONTROL_HTTP_URL=https://control.rallar.intactss.com
```

Override any default by prefixing the deploy command:

```sh
RALLAR_REPO_REF=my-branch ./02-deploy-controller.sh
```

If `RALLAR_CONTROL_ADMIN_TOKEN` is not set, the deploy script generates one and
stores it in `/etc/rallar/control-server.env`.

`14-run-distributed-recipe.sh` uses `RALLAR_CONTROL_HTTP_URL` for
distributed-run admin calls. Keep this on the public HTTPS control origin in
Hetzner runs; the control server rejects plain HTTP distributed-run mutations.

The deploy and rollout scripts also generate or preserve
`RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET` and write the same value to
`/etc/rallar/api-v1.env` and `/etc/rallar/control-server.env`. API-v1 uses it
for `POST /api/black-box/control-token`; the control server uses it to accept
the signed operator token for distributed-run admin operations. Override
`RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS` to change the default 24 hour TTL, or
set `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS` to restrict token brokerage to
specific authenticated client IDs.

The same scripts independently generate or preserve
`RALLAR_AUTH_CREDENTIAL_SECRET` in `/etc/rallar/api-v1.env`. Keep it stable
across rollouts: API-v1 uses it to reconstruct credentials after durable
AppInbox replay without storing plaintext credentials.

## Installed Paths

If the default deploy settings are used, the checked-out repository is installed
on the Hetzner VM at:

```text
/opt/rallar/ar-eye-hunter
```

Main app paths:

```text
API-v1 server:
  /opt/rallar/ar-eye-hunter/apps/api-v1

Black-box control server:
  /opt/rallar/ar-eye-hunter/apps/rallar-black-box-control-server

SPA source:
  /opt/rallar/ar-eye-hunter/apps/rallar-black-box

Built/static SPA served by Caddy:
  /var/www/rallar-black-box
```

Runtime config:

```text
API env:
  /etc/rallar/api-v1.env

Control server env:
  /etc/rallar/control-server.env

Caddy config:
  /etc/caddy/Caddyfile
```

Systemd services:

```text
/etc/systemd/system/rallar-api-v1.service
/etc/systemd/system/rallar-black-box-control.service
```

Data and cache:

```text
Deno cache:
  /var/lib/rallar-deno

Control server persisted runs:
  /var/lib/rallar-black-box-control
```

Useful inspection commands on the VM:

```sh
systemctl cat rallar-api-v1
systemctl cat rallar-black-box-control
ls -la /opt/rallar/ar-eye-hunter
ls -la /var/www/rallar-black-box
```

## Useful Status Commands

```sh
systemctl status rallar-api-v1 --no-pager
systemctl status rallar-black-box-control --no-pager
systemctl status caddy --no-pager
journalctl -u rallar-api-v1 -n 80 --no-pager
journalctl -u rallar-black-box-control -n 80 --no-pager
```
