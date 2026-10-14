# Rallar Hetzner Distributed Recipes

Use the `Run Hetzner Distributed Recipe` GitHub Action to run a checked-in
distributed manifest against Hetzner-hosted headless browser agents.

## Workflow

Workflow file:

```text
.github/workflows/hetzner-distributed-recipe.yml
```

Inputs and their defaults:

```text
ref: main
rollout_before_run: true
agent_source: hetzner              # hetzner | external | mixed
operator_phase: full               # full | prepare | run
agent_count: <blank derives targetPolicy.expectedParticipantCount>
run_id: <blank derives gh-<run id>-<attempt>>
room_id: <blank isolates each spawned Hetzner run>
agent_prefix: controller
control_url: wss://control.rallar.intactss.com/control
control_http_url: https://control.rallar.intactss.com
manifest_path: path/to/distributed-manifest.json
application_id: rallar-server
workspace_id: default
register_before_login: false
browser_log_level: warning         # warning | info | debug
headless_entry: headless           # operator-spa keeps the rollback route
browser_engine: chromium           # chromium | firefox | webkit
install_playwright: true
npm_ci: false
wait_for_agents: true
ready_timeout_seconds: 120
terminal_timeout_seconds: <blank uses metadata.recommendedTerminalTimeoutSeconds, else 300>
stop_after_run: true
```

## Checked-In Manifests

Use these repo manifests with `manifest_path`. Green manifests are ordered from
cheapest confidence check to the low-risk RTC stability baseline. They are
exactly the set `.github/workflows/hetzner-supported-distributed-manifests.yml`
runs on every push to `main`: one `prepare` rollout, then each manifest
serially with `operator_phase=run`.

| Order | Manifest                                                                             | Agents | Purpose                                                                                                |
| ----- | ------------------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------ |
| 1     | `apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json`                     |      2 | Control/headless reachability with `health` and `stats`.                                               |
| 2     | `apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json`         |      2 | Loop, parallel, wait, and assert evidence without live RTC dependency.                                 |
| 3     | `apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json`                  |      2 | Live RTC connect/send/stats smoke.                                                                     |
| 4     | `apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json`            |      2 | Browser-rallar provider parity across connect, direct, multicast, broadcast, health, close, and reset. |
| 5     | `apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json` |      2 | Lower-risk 5 Hz RTC realtime stability stream.                                                         |

Extended manifests keep heavier or longer realtime baselines out of the default
green order:

| Manifest                                                                                                                                                      |   Agents | Purpose                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------------- |
| `apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json`                                                                                     |        2 | Short 10 Hz RTC realtime `rtc.stream` performance baseline.                                    |
| `apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json`                                                                         |        2 | Longer 30 second, 5 Hz RTC realtime stability stream.                                          |
| `apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json`                                                                    |        2 | Longer 30 second, 10 Hz RTC realtime stability stream.                                         |
| `apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json`                                                                    |        2 | Longer 30 second, 15 Hz RTC realtime stability stream.                                         |
| `apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json`                                                                    |        2 | Longer 30 second, 20 Hz RTC realtime stability stream.                                         |
| `apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json`                                                                                    |        3 | Heavier three-agent realtime/load `rtc.stream` baseline.                                       |
| `apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json`                                                               |       50 | One sender multicasts RTC messages at 20 Hz to 49 receivers over a forced tree. Needs rollout. |
| `apps/rallar-black-box/manifests/hetzner/08-rtc-messages-principal-50-agent-30s-20hz-mesh.json`                                                               |       50 | Same traffic over the mesh topology. Needs rollout.                                            |
| `apps/rallar-black-box/manifests/hetzner/09-rtc-messages-all-peer-50-agent-30s-5hz-tree.json`                                                                 |       50 | All 50 peers multicast at 5 Hz over a forced tree. Needs rollout.                              |
| `apps/rallar-black-box/manifests/hetzner/10-rtc-messages-principal-15-agent-30s-20hz-tree.json` through `15-rtc-messages-all-peer-30-agent-30s-5hz-tree.json` |    15/30 | The same principal tree/mesh and all-peer tree runs at 15 and 30 agents. Need rollout.         |
| `apps/rallar-black-box/manifests/hetzner/16-rtc-absence-wait-2-agent.json`                                                                                    |        2 | Positive delivery followed by absence waits (no leak frame, no silent send failure).           |
| `apps/rallar-black-box/manifests/hetzner/17-group-assertions-2-agent.json`                                                                                    |        2 | Coordinator group assertions: `allEqual` convergence and `noneMatch` isolation.                |
| `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`                                                                                     |        2 | ALM conformance family (two peers).                                                            |
| `apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json`                                                                                     |        3 | ALM conformance three-peer family.                                                             |
| `apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json` through `21-alm-conformance-50-agent-30s.json`                                 | 15/30/50 | ALM storage counters over a principal RTC multicast tree. Need rollout.                        |

Diagnostic manifests live under
`apps/rallar-black-box/manifests/hetzner/diagnostic/` and are not part of the
green run order:

| Manifest                                                                | Agents | Purpose                                                                               |
| ----------------------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------- |
| `diagnostic/barrier-health-2-agent.json`                                |      2 | Validates synchronized barrier orchestration before start.                            |
| `diagnostic/expected-failure-1-agent.json`                              |      1 | Intentionally fails to verify analyzer fix proposals and artifact capture.            |
| `diagnostic/rtc-realtime-2-agent-20hz-stress.json`                      |      2 | Strict 20 Hz realtime stress run for stream pacing and backlog diagnostics.           |
| `diagnostic/rtc-messages-all-peer-50-agent-30s-20hz-tree.json`          |     50 | 20 Hz all-peer multicast over a forced tree.                                          |
| `diagnostic/rtc-messages-{all-peer,principal}-50-agent-60m-*-tree.json` |     50 | 60-minute tree soaks at 5, 10, or 20 Hz.                                              |
| `diagnostic/matrix/*.json`                                              |  10–30 | Principal and all-peer tree matrix at 10/15/20/30 agents, 30 s or 5 min, 10 or 20 Hz. |

Regenerate or verify the checked-in JSON from the TypeScript catalog:

```sh
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
```

The manifests use inline recipes so the control server can load them during
staging without relying on SPA state. Every checked-in manifest declares
`applicationId=rallar-server`, `workspaceId=default`, and
`groupId=hetzner-headless-room`. That `groupId` is a template: with a blank
`room_id` (the workflow default) and `agent_source=hetzner`, the runner
materializes a copy whose group is a deterministic `hetzner-run-<sha256>` id
unique to the workflow run attempt, so spawned runs never share a room. A
non-empty `room_id` pins an explicit stable group; `external` and `mixed` runs
and the `prepare` phase keep the manifest group.

The checked-in Hetzner manifests are generated from shared-test recipe builders
and shared distributed-run manifest contracts, and write every author setting
explicitly (a disabled barrier is `{ "enabled": false }`, empty variables and
assignments are `{}` and `[]`). Regenerate them instead of editing the JSON. If a
manifest fails validation in
remote browser agents, check `packages/shared-test/rallar-bb-test/schema.ts`,
`control-protocol.ts`, and the generated manifest JSON together; these must
agree before dispatching on `main`.

## Dispatching Runs

Recommended first run after the manifests are merged to `main`, or whenever the
controller VM should be redeployed from the selected ref:

```sh
scripts/hosted-rallar/dispatch-distributed-recipe.sh \
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
scripts/hosted-rallar/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  --ref main \
  --fast
```

If a fast run reports a missing Playwright browser executable, repair the
browser cache once without redeploying the apps:

```sh
scripts/hosted-rallar/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main \
  --rollout-before-run false \
  --install-playwright true \
  --npm-ci false \
  --register-before-login true
```

The remote installer stages the selected browser under
`/var/lib/rallar-playwright/versions/<playwright-version>-<browser>-<lockfile-sha>`
(root `RALLAR_PLAYWRIGHT_ROOT`), verifies it, and switches the
`/var/lib/rallar-playwright/active` link that headless workers read through
`PLAYWRIGHT_BROWSERS_PATH`. It removes a stale Playwright `__dirlock` only when
no active installer process is running and the lock is older than
`RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS` seconds (`600` by default). After that
repair succeeds, use `--fast` again.

The helper derives `agent_count`, `application_id`, and `workspace_id` from the
manifest and sends `room_id` only when `--room-id <id>` is supplied, so each
spawned run is isolated by default. It creates a sanitized run id from the
manifest file name plus a UTC timestamp (or `--run-id`), uses the manifest's
`metadata.recommendedTerminalTimeoutSeconds` unless
`--terminal-timeout-seconds` or `--fast` is given, and calls
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
The distributed recipe runner sends control-server admin API calls to the
`control_http_url` input (default `https://control.rallar.intactss.com`)
because distributed-run creation requires TLS; `control_url` (default
`wss://control.rallar.intactss.com/control`) is the agents' control WebSocket.

Manual full-rollout equivalent:

```sh
gh workflow run hetzner-distributed-recipe.yml \
  --ref main \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json \
  -f agent_count=2 \
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

The rollout records `/var/lib/rallar-black-box-control/deployment-readiness.json`
(deployed commit, `package-lock.json` sha256, Playwright version, browser
engine and path, operating system, and service health), and `run`-phase jobs
reject a stale record. Rollout itself still redeploys fully; recording an SPA
build hash and a service config hash would let it repair only stale pieces.

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
RALLAR_BLACK_BOX_CONTROL_READ_TOKEN   # admin/operator token for protected control reads
RALLAR_BLACK_BOX_CONTROL_TOKEN        # legacy fallback for the read token
```

## Remote Execution

The workflow materializes the manifest on the runner
(`scripts/hosted-rallar/actions/materialize-hetzner-run-manifest.mjs`), copies
`scripts/hosted-rallar/controller` and the materialized manifest to the VM, then
runs:

```text
10-stop-headless-workers.sh    # before rollout and before starting hetzner/mixed agents
08-rollout-controller.sh       # rollout_before_run=true and operator_phase is not run
09-start-headless-workers.sh   # agent_source=hetzner or mixed: starts N browser agents
16-wait-for-control-agents.sh  # agent_source=external or mixed, when wait_for_agents=true
14-run-distributed-recipe.sh   # creates, stages, starts, polls, exports
```

`operator_phase=prepare` stops after the rollout and writes the marker
`/tmp/rallar-distributed-prepare-<distributedRunId>.json`; it runs no recipe and
uploads no distributed artifacts. `operator_phase=run` skips rollout, checks
`/var/lib/rallar-black-box-control/deployment-readiness.json` against the ref
for non-external agents, and checks the prepare marker when the manifest sets
`metadata.rtcTopologyEnv`. Outside the `run` phase such a manifest requires
`rollout_before_run=true`.

The workflow sets `RALLAR_DISTRIBUTED_CONTROL_RUN_ID` to the same value as
`RALLAR_BLACK_BOX_RUN_ID` so the distributed run targets the control run where
the headless browser agents registered.

## Artifacts

The remote runner writes:

```text
/tmp/rallar-distributed-runs/<distributedRunId>/
```

The GitHub workflow uploads that directory as
`hetzner-distributed-<distributedRunId>`, then writes analyzer output under
`analysis/` and uploads it separately as
`hetzner-distributed-analysis-<distributedRunId>`. The summary, fix proposal,
and performance report are appended to the GitHub Actions step summary when
artifacts were copied. Every run, including `prepare` and runs that fail before
a recipe starts, also uploads `hetzner-operation-<distributedRunId>` with
`operation-report.json`, `summary.md`, and a sanitized `evidence.log`. Read it
first: when its `recipeStarted` is `false`, a missing distributed artifact is
expected.

Important files:

```text
runner-summary.json
distributed-run.json
distributed-artifact-bundle.json
manifest.json
control-run.json
report.json
results.jsonl
events.jsonl
failures.json
fleet-report.json
fleet-report-artifact-bundle.json
fleet-report-summary.md
analysis/analysis.json
analysis/summary.md
analysis/fix-proposal.md      # failed runs
analysis/performance.md       # whenever control-run.json was analyzed, passed or failed
```

When the control server rejects the create request, the runner never gets a
distributed run: the folder holds `control-post-create-error.json` (the response
body, when there was one), `control-post-error-metadata.json` (method, path,
HTTP and curl status, exit code), `runner-summary.json` and `manifest.json`, and
no `distributed-run.json`. The analyzer recognises that folder as a control
request failure and writes `analysis/analysis.json`, `analysis/summary.md` and
`analysis/fix-proposal.md` naming the failed request, its status and the error
body. It writes no `performance.md`, because no run exists to measure.

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
warnings in `analysis/analysis.json` and `analysis/summary.md`. A missing
`manifest.json` is a warning too: the analysis still runs, but no artifact
bundle is formed.

`distributed-run.json` must match the control server's snapshot contract. When
it is missing, empty, not JSON, or missing a field the control server always
writes (for example `createdAtEpochMs` or a rollup counter), the analyzer prints
the rejection naming the file and the field, writes no analysis files, and exits
with status 1. The one exception is the failed control request folder described
above.

The runner exports `control-run.json` only when it has a control run id and its
GET succeeds, so the analyzer treats that file as optional evidence. When it is
missing or does not match the control run snapshot contract, the analysis still
runs: a parse warning names the file, `analysis/summary.md` says that performance
and the SPA report and verdict were not analyzed, and `analysis.json` omits
`performance` and `spa` (and, without a fleet report, the agent count). No
`performance.md` is written, and where the failure focus would use the SPA
report it explains the first failure `distributed-run.json` records.

When `control-run.json` holds no results or events, `results.jsonl` and
`events.jsonl` rows that name their agent, command and outcome stand in for
them; the analysis never invents command links or placeholder identities from
those rows. A row that cannot stand in is a parse warning naming its line and
the missing field.

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

For realtime manifests, also review the stream timing section: stream count,
completed/planned frames, attempted frames, failed frames, dropped frames,
backpressure count, p50/p95/p99/max stream send duration, achieved Hz, and
slowest stream agents. These manifests use one bounded `rtc.stream` command per
agent instead of expanding the realtime traffic into many sequential `rtc.send`
commands, so stream frame metrics are the primary performance baseline. The
backpressure count counts frames a carrier refused at admission for its own rate
limit or open circuit (`rate-limited`, `circuit-open`), not channel
backpressure: a carrier at its high watermark refuses an ALM send `congested`
or holds it `not-ready`, which the agent's `stats.rallar.congestion` counters
read.

## SPA Review

Download the raw distributed artifact from GitHub Actions and import its JSON
and JSONL files in the `rallar-black-box` Runs panel with `Import CI artifact`.
The SPA uses the same analysis core as the CLI and rejects the same
non-conforming folders; a failed control request folder has no run to import,
so read its `analysis/fix-proposal.md` instead. For a valid run it shows the verdict,
likely cause, next action, minimal fix area, evidence file, warnings, and
performance baseline beside the live distributed run monitor. Imported stream
runs show stream frames, p50/p95/p99 stream send duration, drops, backpressure
(admission refusals), achieved Hz, and slowest stream agent rows in the Performance Health band.
