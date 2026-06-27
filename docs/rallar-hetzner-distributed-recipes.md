# Rallar Hetzner Distributed Recipes

Use the `Run Hetzner Distributed Recipe` GitHub Action to run a checked-in
distributed manifest against Hetzner-hosted headless browser agents.

## Workflow

Workflow file:

```text
.github/workflows/hetzner-distributed-recipe.yml
```

Typical inputs:

```text
ref: main
rollout_before_run: true
agent_count: 2
run_id: <blank for GitHub-derived id>
room_id: hetzner-headless-room
agent_prefix: controller
manifest_path: path/to/distributed-manifest.json
application_id: rallar-server
workspace_id: default
register_before_login: false
install_playwright: true
wait_for_agents: true
ready_timeout_seconds: 120
terminal_timeout_seconds: 300
stop_after_run: true
```

## Checked-In Manifests

Use these repo manifests with `manifest_path`. Green manifests are ordered from
cheapest confidence check to heavier RTC/load baseline:

| Order | Manifest | Agents | Purpose |
| --- | --- | ---: | --- |
| 1 | `apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json` | 2 | Control/headless reachability with `health` and `stats`. |
| 2 | `apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json` | 2 | Loop, parallel, wait, and assert evidence without live RTC dependency. |
| 3 | `apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json` | 2 | Live RTC connect/send/stats smoke. |
| 4 | `apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json` | 2 | Browser-rallar provider parity across connect, direct, multicast, broadcast, health, close, and reset. |
| 5 | `apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json` | 2 | Short 20 Hz RTC realtime `rtc.stream` performance baseline. |
| 6 | `apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json` | 3 | Heavier three-agent realtime/load `rtc.stream` baseline. |

Diagnostic manifests live under
`apps/rallar-black-box/manifests/hetzner/diagnostic/` and are not part of the
green run order:

| Manifest | Agents | Purpose |
| --- | ---: | --- |
| `diagnostic/barrier-health-2-agent.json` | 2 | Validates synchronized barrier orchestration before start. |
| `diagnostic/expected-failure-1-agent.json` | 1 | Intentionally fails to verify analyzer fix proposals and artifact capture. |

Regenerate or verify the checked-in JSON from the TypeScript catalog:

```sh
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
```

The manifests use inline recipes so the control server can load them during
staging without relying on SPA state. They default to
`applicationId=rallar-server`, `workspaceId=default`, and
`groupId=hetzner-headless-room`, matching the workflow defaults.

The checked-in Hetzner manifests are generated from shared-test recipe builders
and shared distributed-run manifest contracts. If a manifest fails validation in
remote browser agents, check `packages/shared-test/rallar-bb-test/schema.ts`,
`control-protocol.ts`, and the generated manifest JSON together; these must
agree before dispatching on `main`.

## Dispatching Runs

Recommended first run after the manifests are merged to `main`, or whenever the
controller VM should be redeployed from the selected ref:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main
```

The dispatch helper sends `register_before_login=true` by default because the
Hetzner controller currently uses a memory-backed API and a full rollout clears
the disposable test user. Override with `--register-before-login false` only
when the target API already has persistent pre-provisioned users. The raw
workflow input still defaults to `false` for manual compatibility.

For faster iteration after a successful deploy of the same ref, skip rollout,
Playwright install, and `npm ci`:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  --ref main \
  --fast
```

If a fast run reports a missing Playwright browser executable, repair the
browser cache once without redeploying the apps:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main \
  --rollout-before-run false \
  --install-playwright true \
  --npm-ci false \
  --register-before-login true
```

The remote installer writes Chromium into the `rallar` user cache and removes a
stale Playwright `__dirlock` only when no active installer process is running
and the lock is older than `RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS` seconds
(`600` by default). After that repair succeeds, use `--fast` again.

The helper derives `agent_count`, `room_id`, `application_id`, and
`workspace_id` from the manifest, creates a sanitized run id, and calls
`gh workflow run`. It preflights the required repository or `production`
environment secrets and refuses diagnostic manifests unless `--allow-diagnostic`
is supplied. The `--fast` flag maps to `rollout_before_run=false`,
`install_playwright=false`, `npm_ci=false`, `wait_for_agents=true`,
`ready_timeout_seconds=60`, and `terminal_timeout_seconds=180`. The helper also
defaults `register_before_login=true` and `stop_after_run=true`. Passing only
`rollout_before_run=false` does not skip Playwright unless
`install_playwright=false` is also supplied. Pass `--keep-headless` only when
you intentionally want to leave browser processes running after artifact capture
for live debugging or back-to-back warm experiments.
The distributed recipe runner uses `https://control.rallar.intactss.com` for
control-server admin API calls because distributed-run creation requires TLS.

Manual full-rollout equivalent:

```sh
gh workflow run hetzner-distributed-recipe.yml \
  --ref main \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  -f agent_count=2 \
  -f room_id=hetzner-headless-room \
  -f application_id=rallar-server \
  -f workspace_id=default \
  -f register_before_login=true \
  -f ref=main \
  -f stop_after_run=true \
  -f rollout_before_run=true
```

Manual fast-iteration equivalent:

```sh
gh workflow run hetzner-distributed-recipe.yml \
  --ref main \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  -f agent_count=2 \
  -f room_id=hetzner-headless-room \
  -f application_id=rallar-server \
  -f workspace_id=default \
  -f register_before_login=true \
  -f ref=main \
  -f rollout_before_run=false \
  -f install_playwright=false \
  -f npm_ci=false \
  -f wait_for_agents=true \
  -f ready_timeout_seconds=60 \
  -f terminal_timeout_seconds=180 \
  -f stop_after_run=true
```

Longer term, rollout can become faster by recording VM stamp files for deployed
git SHA, `package-lock.json` hash, Playwright browser version, SPA build hash,
and service config hash. That would let the rollout path verify and repair only
missing or stale runtime pieces instead of always doing a full deploy.

Required production secrets:

```text
HETZNER_HOST
HETZNER_USER
HETZNER_SSH_PRIVATE_KEY
HETZNER_KNOWN_HOSTS
RALLAR_BLACK_BOX_USERNAME
RALLAR_BLACK_BOX_PASSWORD
```

Optional:

```text
RALLAR_BLACK_BOX_CONTROL_TOKEN
```

## Remote Execution

The workflow copies `scripts/hetzner/controller` and the manifest to the VM,
then runs:

```text
08-rollout-controller.sh       # optional
09-start-headless-workers.sh   # starts N browser agents
14-run-distributed-recipe.sh   # creates, stages, starts, polls, exports
```

The workflow sets `RALLAR_DISTRIBUTED_CONTROL_RUN_ID` to the same value as
`RALLAR_BLACK_BOX_RUN_ID` so the distributed run targets the control run where
the headless browser agents registered.

## Artifacts

The remote runner writes:

```text
/tmp/rallar-distributed-runs/<distributedRunId>/
```

The GitHub workflow uploads that directory and then writes analyzer output under
`analysis/`. The same summary is appended to the GitHub Actions step summary
when artifacts were copied.

Important files:

```text
runner-summary.json
distributed-run.json
manifest.json
control-run.json
report.json
results.jsonl
events.jsonl
failures.json
fleet-report.json
fleet-report-summary.md
analysis/analysis.json
analysis/summary.md
analysis/fix-proposal.md      # failed runs
analysis/performance.md       # passed runs
```

## Failure Handling

The recipe step is allowed to fail while the workflow continues long enough to
copy artifacts and run analysis. The final workflow step fails the job if the
distributed run did not pass.

For failed runs, start with:

```text
analysis/fix-proposal.md
analysis/analysis.json
```

The proposal reports the likely cause, affected agents or regions, first useful
evidence, minimal fix area, and a focused verification command.

Malformed optional artifacts and malformed JSONL rows are reported as parse
warnings in `analysis/analysis.json` and `analysis/summary.md`. A malformed
`distributed-run.json` remains a hard analysis error.

## Success Handling

For passed runs, start with:

```text
analysis/performance.md
analysis/analysis.json
```

Review pass rate, run duration, command p50/p95/max, reconnect count,
diagnostic count, exported event count, agent-reported event count, and
stale/missing/flaky agent counts. If no baseline exists, treat the first clean
run as the baseline.

For `05-rtc-realtime-2-agent-5s.json` and
`06-rtc-realtime-3-agent-15s.json`, also review the stream timing section:
stream count, completed/planned frames, attempted frames, failed frames, dropped
frames, backpressure count, p50/p95/p99/max stream send duration, achieved Hz,
and slowest stream agents. These manifests use one bounded `rtc.stream` command
per agent instead of expanding the realtime traffic into many sequential
`rtc.send` commands, so stream frame metrics are the primary performance
baseline.

## SPA Review

Download the raw distributed artifact from GitHub Actions and import its JSON
and JSONL files in the `rallar-black-box` Runs panel with `Import CI artifact`.
The SPA uses the same analysis core as the CLI, then shows the verdict,
likely cause, next action, minimal fix area, evidence file, warnings, and
performance baseline beside the live distributed run monitor. Imported stream
runs show stream frames, p50/p95/p99 stream send duration, drops, backpressure,
achieved Hz, and slowest stream agent rows in the Performance Health band.
