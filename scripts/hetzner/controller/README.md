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
```

Important: these scripts stop or start services on the VM. They do not stop
Hetzner billing. Delete the VM if you want billing to stop.

Also note that API-v1 uses `pglite-memory`; stopping or restarting
`rallar-api-v1.service` resets API-v1 in-memory data. Control-server snapshots
are persisted under `/var/lib/rallar-black-box-control`.

## Defaults

The deploy script defaults to:

```text
RALLAR_REPO_URL=https://github.com/intact-software-systems/ar-eye-hunter.git
RALLAR_REPO_REF=main
RALLAR_CHECKOUT_DIR=/opt/rallar/ar-eye-hunter
RALLAR_API_HOST=api.rallar.intactss.com
RALLAR_CONTROL_HOST=control.rallar.intactss.com
RALLAR_BLACKBOX_HOST=blackbox.rallar.intactss.com
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
