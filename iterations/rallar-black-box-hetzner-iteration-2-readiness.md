# Rallar Black-Box Hetzner Iteration 2 Readiness

This document details what must be prepared before implementing Iteration 2, the
controller VM pilot, from
`iterations/rallar-black-box-hetzner-deployment-plan.md`.

Iteration 2 should produce one Hetzner controller VM that runs:

- API-v1 in `pglite-memory` mode
- the Rallar black-box control server
- the `rallar-black-box` SPA over HTTPS
- a reverse proxy that exposes only public HTTPS routes

The recommended path for this pilot is one x86 Hetzner Cloud VM, Caddy for
HTTPS/reverse proxy, systemd services for API-v1 and the control server, and a
static built SPA served by Caddy.

## Step 1: Choose The Pilot Shape

Decision required:

- Use one controller VM for API-v1, control server, and SPA.
- Use x86 for the first controller pilot.
- Use systemd plus Caddy instead of Docker Compose for this iteration.
- Keep `RALLAR_ICE_MODE=local` for the first controller-only smoke.

Recommended values:

```text
controller topology: one VM
controller architecture: x86
deployment style: systemd services + Caddy
SPA hosting: static dist served by Caddy
ICE mode for iteration 2: local
```

Output needed before implementation:

- confirmation that this shape is acceptable, or a specific alternative

Codex can do after this:

- create VM setup notes or a bootstrap script that matches the chosen shape
- create systemd unit templates
- create a Caddyfile template

## Step 2: Prepare Hetzner Cloud Access

Decision/action required:

- Create or choose a Hetzner Cloud project.
- Add your SSH public key to Hetzner Cloud.
- Decide whether provisioning will be manual in the Hetzner UI or scripted with
  a Hetzner API token.

Recommended for this pilot:

- Manual VM creation is fine if you want the lowest setup overhead.
- Scripted provisioning is better if you want repeatable destroy/recreate
  cycles.

Output needed before implementation:

```text
Hetzner project name:
SSH key name in Hetzner:
Provisioning mode: manual | scripted
Hetzner API token available locally: yes | no
```

Secret handling:

- Do not commit a Hetzner API token to the repo.
- If scripted provisioning is chosen, put the token in your local shell or a
  local-only secret store, not in a markdown document.

Codex can do after this:

- write a manual runbook, or
- write a script/cloud-init flow that assumes `HCLOUD_TOKEN` is available in the
  local environment

## Step 3: Pick Region And VM Size

Decision required:

- Choose the Hetzner region for the controller.
- Choose the initial server type.

Recommended for the first pilot:

```text
region: same region you expect to use for the first browser worker
server type: shared CPU x86 with about 8 GB RAM
backups: disabled
snapshots: disabled
volumes: none for the first smoke
```

Reasoning:

- `pglite-memory` makes the API-v1 controller RAM-sensitive.
- The controller should not also be a large browser worker in this iteration.
- Backups, snapshots, and volumes add cost and are not needed for the first
  throwaway smoke.

Output needed before implementation:

```text
controller region:
controller server type:
expected controller lifetime: hours | days
```

Codex can do after this:

- size the bootstrap docs and cost guardrails around the chosen region/type
- add cleanup instructions for the exact VM shape

## Step 4: Choose Public Hostnames

Decision/action required:

- Choose the public DNS names for API-v1, the control server, and the SPA.
- Make sure you can create DNS `A` records for those names.

Recommended pattern:

```text
api.<your-domain>
control.<your-domain>
blackbox.<your-domain>
```

DNS records to create after the VM exists:

```text
api.<your-domain>      A  <controller-public-ip>
control.<your-domain>  A  <controller-public-ip>
blackbox.<your-domain> A  <controller-public-ip>
```

Output needed before implementation:

```text
API hostname:
control hostname:
black-box SPA hostname:
DNS provider access available: yes | no
```

Codex can do after this:

- generate the Caddyfile with the correct hostnames
- generate API-v1 and control-server environment files with matching public URLs

## Step 5: Decide Firewall Exposure

Decision/action required:

- Decide how SSH should be restricted.
- Expose only SSH, HTTP, and HTTPS publicly.
- Do not expose API-v1 port `8080` or control-server port `5180` directly.

Recommended firewall:

```text
inbound tcp/22: your IP address if stable, otherwise temporarily open while debugging
inbound tcp/80: public, for ACME HTTP challenge and redirect
inbound tcp/443: public
inbound tcp/8080: blocked
inbound tcp/5180: blocked
outbound: allow
```

Output needed before implementation:

```text
SSH source IP restriction:
temporary open SSH acceptable during pilot: yes | no
```

Codex can do after this:

- write firewall setup notes
- write Caddy reverse proxy routes so public traffic goes through HTTPS

## Step 6: Prepare Server Secrets

Decision/action required:

- Generate a control-server admin token.
- Decide whether run tokens are required in Iteration 2.
- Choose fixture users/passwords for API-v1 black-box login.

Recommended for a public VM:

```text
RALLAR_BLACK_BOX_ADMIN_TOKEN=<strong-random-token>
RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=0 for the first controller-only smoke
RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN=1 before public remote workers are added
```

Fixture credential options:

- Use one shared test user for the first smoke.
- Use per-agent users later when Iteration 3 adds worker VMs.

Important:

- Do not place real secrets in Vite `VITE_*` variables or checked-in files.
- Browser query parameters and Vite-exposed variables are public by design.
- For Iteration 2, keep server secrets in VM-local `.env` files readable only by
  the service user.

Output needed before implementation:

```text
control admin token generated: yes | no
first smoke username:
first smoke password available privately: yes | no
require run tokens in iteration 2: yes | no
```

Codex can do after this:

- create `.env.example` templates without secret values
- create systemd unit files that read VM-local env files

## Step 7: Confirm Runtime Environment Values

Decision required:

- Confirm the public URLs and memory-mode API-v1 settings.
- Confirm the control-server host allow-list.

API-v1 controller env template:

```text
PORT=8080
CORS_ORIGINS=https://blackbox.<your-domain>
RALLAR_API_BASE_URL=https://api.<your-domain>
RALLAR_WS_BASE_URL=wss://api.<your-domain>
RALLAR_SQL_BACKEND=pglite-memory
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=local
RALLAR_ICE_MODE=local
RALLAR_LOGIN_USER_RATE_LIMIT=100
```

Control-server env template:

```text
PORT=5180
RALLAR_BLACK_BOX_ADMIN_TOKEN=<server-only-secret>
RALLAR_BLACK_BOX_REQUIRE_TLS=1
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://blackbox.<your-domain>
RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS=api.<your-domain>
RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS=api.<your-domain>,control.<your-domain>
RALLAR_BLACK_BOX_STORAGE_DIR=/var/lib/rallar-black-box-control
RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=50
```

SPA public configuration:

- Prefer URL query parameters for worker control-agent runs.
- Do not bake fixture passwords into a public static bundle.

Output needed before implementation:

```text
API public base URL:
API public websocket base URL:
control public websocket URL:
SPA public URL:
storage directory acceptable: yes | no
retention max runs:
```

Codex can do after this:

- create env templates and a deployment runbook
- add sanity checks that verify each URL and host allow-list

## Step 8: Decide Repository Deployment Method

Decision/action required:

- Decide how the VM receives the code.

Reasonable options:

- `git clone` from the repository on the VM
- upload a prepared artifact bundle
- build locally and copy only the dist/server files

Recommended for the first pilot:

```text
method: git clone on VM
branch: current working branch for the pilot
build location: VM
```

Reasoning:

- It is easiest to debug because source, scripts, and docs are present.
- It avoids inventing a packaging pipeline before the controller pilot works.

Output needed before implementation:

```text
repository access from VM: public | SSH deploy key | personal access method
branch to deploy:
```

Codex can do after this:

- write clone/build commands
- write systemd units that point at the chosen checkout path

Controller install scripts now exist under `scripts/hetzner/controller/`.

Copy them to the VM:

```sh
scp -r scripts/hetzner/controller root@api.rallar.intactss.com:/tmp/rallar-controller
```

Run them on the VM as `root`:

```sh
cd /tmp/rallar-controller
chmod +x *.sh
./01-install-runtime.sh
./02-deploy-controller.sh
./03-smoke-controller.sh
```

The deploy script defaults to cloning
`https://github.com/intact-software-systems/ar-eye-hunter.git` at `main` into
`/opt/rallar/ar-eye-hunter`. Override with `RALLAR_REPO_URL`, `RALLAR_REPO_REF`,
or `RALLAR_CHECKOUT_DIR` if needed.

## Step 9: Define Controller Smoke Checks

Decision required:

- Decide the minimum checks that mean Iteration 2 is complete.

Recommended checks:

```text
GET https://api.<your-domain>/api/config
GET https://api.<your-domain>/api/docs
GET https://control.<your-domain>/health
GET https://blackbox.<your-domain>/
API-v1 memory mode logs show pglite-memory
control server logs show app rallar-black-box-control-server
controller memory remains stable for 30 minutes without browser workers
```

Optional controller-only worker check:

```text
run one local headless worker on the controller VM
confirm GET https://control.<your-domain>/runs/<runId> shows connected: true
stop worker
confirm the same run shows connected: false
```

Output needed before implementation:

```text
controller-only worker smoke desired in iteration 2: yes | no
30-minute idle soak required before iteration 3: yes | no
```

Codex can do after this:

- write the exact smoke commands
- add a results template for recording the controller pilot

## Step 10: Define Cleanup Rules

Decision required:

- Decide when the controller VM should be destroyed.
- Decide whether any artifacts must be copied out first.

Recommended cleanup for this cost-focused pilot:

```text
destroy workers after each run
destroy controller after the pilot unless another test is scheduled soon
copy control-server artifacts before destroy if the run produced useful data
record VM runtime hours in the test notes
```

Output needed before implementation:

```text
keep controller after successful iteration 2: yes | no
artifact destination before destroy:
maximum acceptable idle time:
```

Codex can do after this:

- add explicit cleanup steps to the runbook
- add artifact-copy commands once the destination is known

Controller service-control scripts now exist under
`scripts/hetzner/controller/`:

```sh
./04-stop-controller.sh
./05-start-controller.sh
./06-restart-controller.sh
./07-status-controller.sh
```

These scripts manage the API-v1 and control-server systemd services. They leave
Caddy running by default so HTTPS and the static SPA still respond. Set
`RALLAR_INCLUDE_CADDY=1` when running the stop/start/restart scripts if Caddy
should be included too.

Important cleanup caveats:

- stopping or restarting `rallar-api-v1.service` resets API-v1 `pglite-memory`
  data
- control-server snapshots persist in `/var/lib/rallar-black-box-control`
- stopping services does not stop Hetzner billing; delete the VM when the
  controller itself should stop costing money

## Information To Provide Before We Start Iteration 2

Fill this in locally or send the non-secret values:

```text
Provisioning mode:
Hetzner project:
SSH key name:
Controller region:
Controller server type:
API hostname:
Control hostname:
SPA hostname:
SSH source restriction:
Repository deploy method:
Branch to deploy:
Require run tokens in iteration 2:
Controller-only worker smoke:
Keep controller after pilot:
```

Keep these private, but confirm they exist:

```text
Hetzner API token, if scripted provisioning is chosen
control-server admin token
fixture user password
repository deploy key or private access method, if needed
```

## Ready-To-Start Criteria

Iteration 2 is ready to implement when:

- the controller topology is confirmed
- region and server type are chosen
- public hostnames are chosen
- DNS can be updated after the VM gets an IP address
- SSH access is available
- server-only secrets are generated or ready to generate on the VM
- repository access from the VM is decided
- cleanup expectations are explicit
