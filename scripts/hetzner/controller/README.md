# Rallar Hetzner Controller Scripts

These scripts configure the Iteration 2 controller VM on Ubuntu 24.04 LTS.

Run them as `root` on `rallar-controller-fsn1-01`.

## Copy Scripts To The VM

From your local machine:

```sh
scp -r scripts/hetzner/controller root@api.rallar.intactss.com:/tmp/rallar-controller
```

Then SSH to the VM:

```sh
ssh root@api.rallar.intactss.com
cd /tmp/rallar-controller
chmod +x *.sh
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

Also note that API-v1 uses `pglite-memory`; stopping or restarting
`rallar-api-v1.service` resets API-v1 in-memory data. Control-server snapshots
are persisted under `/var/lib/rallar-black-box-control`.

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
9. Refresh `CORS_ORIGINS` in `/etc/rallar/api-v1.env`.
10. Start API/control services, reload Caddy, and run local health checks.
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
also pass:

```sh
RALLAR_BLACK_BOX_CONTROL_TOKEN=<run-or-agent-token>
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

API-v1 starts with `RALLAR_ICE_MODE=local`, which intentionally returns
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

Optional GitHub secret when run tokens are enabled:

```text
RALLAR_BLACK_BOX_CONTROL_TOKEN
```

Use `action=start` with the desired `agent_count` to launch browsers. Use
`action=stop` to stop them. Use `action=status` to inspect the current service
and connected agents.

By default `action=start` and `action=restart` first stop the existing headless
worker service, run `08-rollout-controller.sh` for the selected `ref`, refresh
API/control CORS policy from the public SPA URL, and then start the headless
worker service. Set `rollout_before_start=false` when you only want to reuse the
already-deployed checkout and restart browsers from the existing VM files.

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
```

Override any default by prefixing the deploy command:

```sh
RALLAR_REPO_REF=my-branch ./02-deploy-controller.sh
```

If `RALLAR_CONTROL_ADMIN_TOKEN` is not set, the deploy script generates one and
stores it in `/etc/rallar/control-server.env`.

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
