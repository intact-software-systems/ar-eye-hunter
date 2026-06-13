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
5. Build the rallar-black-box SPA.
6. Stop rallar-api-v1.service and rallar-black-box-control.service.
7. Publish static SPA files to /var/www/rallar-black-box.
8. Refresh `CORS_ORIGINS` in `/etc/rallar/api-v1.env`.
9. Start API/control services, reload Caddy, and run local health checks.
10. Print service status and recent logs.
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

When both Metered secrets are set, the workflow syncs them into
`/etc/rallar/api-v1.secrets.env` on the VM before rollout. When both are absent,
the workflow leaves the VM untouched and keeps reusing the existing secret file
if one is already present. If only one Metered secret is set, the workflow fails
before rollout so it does not overwrite a working TURN setup with partial
credentials.

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
agent_count
run_id
room_id
agent_prefix
spa_url
control_url
api_base_url
install_playwright
npm_ci
wait_for_agents
ready_timeout_seconds
```

Required GitHub secrets:

```text
HETZNER_HOST
HETZNER_USER
HETZNER_SSH_PRIVATE_KEY
HETZNER_KNOWN_HOSTS
RALLAR_BLACK_BOX_USERNAME
RALLAR_BLACK_BOX_PASSWORD
```

Optional GitHub secret when run tokens are enabled:

```text
RALLAR_BLACK_BOX_CONTROL_TOKEN
```

Use `action=start` with the desired `agent_count` to launch browsers. Use
`action=stop` to stop them. Use `action=status` to inspect the current service
and connected agents.

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
