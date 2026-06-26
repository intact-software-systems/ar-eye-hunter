# GitHub Action Workflow

Use `.github/workflows/hetzner-distributed-recipe.yml`.

## Required Inputs

- `manifest_path`: repo path to a distributed run manifest JSON file.

## Manifest Library

Use checked-in manifests under `apps/rallar-black-box/manifests/hetzner/`.
Run green manifests in this order:

1. `01-health-2-agent.json`
2. `02-composite-evidence-2-agent.json`
3. `03-rtc-smoke-2-agent.json`
4. `04-provider-parity-2-agent.json`
5. `05-rtc-realtime-2-agent-5s.json`
6. `06-rtc-realtime-3-agent-15s.json`

Diagnostic manifests under `diagnostic/` require an explicit opt-in because one
is intentionally failing.

Preferred dispatch helper:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main
```

Use that full-rollout form for the first run after a code change or fresh VM
setup. For repeated runs after the selected ref is already deployed, use the
fast path:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  --ref main \
  --fast
```

If fast mode fails because the Playwright browser executable is missing, repair
the browser cache once without redeploying apps:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main \
  --rollout-before-run false \
  --install-playwright true \
  --npm-ci false
```

The remote Playwright installer clears stale `__dirlock` files only when no
active installer process is running and the lock is older than
`RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS` seconds, default `600`. After the repair
succeeds, return to `--fast`.

The helper derives `agent_count`, `room_id`, `application_id`, and
`workspace_id` from the manifest. It checks the required repository or
`production` environment secret names before dispatch and refuses diagnostic
manifests unless `--allow-diagnostic` is supplied. `--fast` sets
`rollout_before_run=false`, `install_playwright=false`, `npm_ci=false`,
`wait_for_agents=true`, `ready_timeout_seconds=60`, and
`terminal_timeout_seconds=180`. Passing `rollout_before_run=false` by itself
does not skip Playwright; also pass `install_playwright=false` or use `--fast`.

## Common Inputs

- `agent_count`: number of headless browser agents.
- `run_id`: optional control run id. Leave blank for `gh-<run>-<attempt>`.
- `room_id`, `agent_prefix`, `application_id`, `workspace_id`: headless agent
  scope.
- `rollout_before_run`: roll out the selected ref before the run.
- `install_playwright`: install/update Chromium and Linux dependencies before
  starting browsers.
- `npm_ci`: run `npm ci` before starting the headless worker.
- `wait_for_agents`: wait until requested agents are connected.
- `ready_timeout_seconds`: agent and distributed readiness timeout.
- `terminal_timeout_seconds`: distributed recipe terminal-state timeout.
- `register_before_login`: use for memory-backed API redeploys with disposable
  users.
- `stop_after_run`: stop the headless worker service after artifacts are
  collected.

Manual fast-iteration dispatch:

```sh
gh workflow run hetzner-distributed-recipe.yml \
  --ref main \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  -f agent_count=2 \
  -f room_id=hetzner-headless-room \
  -f application_id=rallar-server \
  -f workspace_id=default \
  -f ref=main \
  -f rollout_before_run=false \
  -f install_playwright=false \
  -f npm_ci=false \
  -f wait_for_agents=true \
  -f ready_timeout_seconds=60 \
  -f terminal_timeout_seconds=180
```

Longer term, optimize rollout with VM stamp files for deployed git SHA,
`package-lock.json` hash, Playwright browser version, SPA build hash, and
service config hash so rollout can verify and repair stale pieces instead of
always running the full deploy.

## Required Secrets

- `HETZNER_HOST`
- `HETZNER_USER`
- `HETZNER_SSH_PRIVATE_KEY`
- `HETZNER_KNOWN_HOSTS`
- `RALLAR_BLACK_BOX_USERNAME`
- `RALLAR_BLACK_BOX_PASSWORD`

Optional:

- `RALLAR_BLACK_BOX_CONTROL_TOKEN`

## Remote Behavior

The workflow copies controller scripts and the manifest to the VM, optionally
runs `08-rollout-controller.sh`, starts browsers with
`09-start-headless-workers.sh`, runs `14-run-distributed-recipe.sh`, copies
artifacts back, analyzes them when available, appends the analyzer markdown to
the GitHub step summary, uploads artifacts, and fails only after evidence is
uploaded when the distributed run did not pass.

For passed runs, start with `analysis/performance.md`. For failed runs, start
with `analysis/analysis.json`, then `analysis/fix-proposal.md`, then the cited
raw evidence file.
