# GitHub Free Rallar Black Box Headless Runbook

This runbook is for manual validation of
`.github/workflows/github-free-distributed-recipe.yml`. It starts
GitHub-hosted headless browser shards, reuses the public Hetzner control/API
environment, and lets the Hetzner operator stage, start, export, and analyze
the distributed run in the default `execution_mode=hetzner-control` mode.

## Frozen All-local ALM Observation

Dispatch the existing workflow on the reviewed feature branch with:

```text
execution_mode=all-local
manifest_path=apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json
target_agent_count=15
browser_engine=chromium
register_before_login=true
```

The local job rejects conflicting values for these frozen inputs before toolchain
setup. All other dispatch inputs configure only `hetzner-control`; the local job
uses its own loopback URLs, fixed manifest identities and existing fixture budgets.
It starts API-v1 memory mode, the standalone headless SPA and the control server
through the existing Playwright lifecycle, then one Chromium worker with 15 isolated
contexts. It uses no deployment, production secrets or external control operation.
The shared queued concurrency group and exact `${{ github.sha }}` checkout apply
to both modes. The registered manual workflow can run the feature branch before merge.

For a local rehearsal, run the same steps the workflow runs: admit the manifest
(which writes `source-manifest.json` into fresh recorder storage), then the
Playwright lifecycle with the variables the spec requires. The ports are the
workflow's; any free loopback ports work when another session holds them.

```sh
N=15   # 15, 30 or 50
case $N in
  15) M=apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json;;
  30) M=apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json;;
  50) M=apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json;;
esac
export MANIFEST_PATH=$M TARGET_AGENT_COUNT=$N BROWSER_ENGINE=chromium REGISTER_BEFORE_LOGIN=true
mkdir -p tmp/alm-v1c
export RALLAR_BLACK_BOX_STORAGE_DIR="$(mktemp -d "$PWD/tmp/alm-v1c/all-local-recorder.XXXXXX")"
node apps/rallar-black-box/scripts/select-all-local-alm-manifest.mjs
node --import tsx apps/rallar-black-box/scripts/select-all-local-alm-manifest.mjs --admit
CI=1 RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_FULL_STACK_HEADLESS=1 \
RALLAR_BLACK_BOX_API_MODE=memory RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=$((N + 1)) \
RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS=unbounded RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS=unbounded \
RALLAR_BLACK_BOX_MANIFEST_PATH=$MANIFEST_PATH RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT=$N \
VITE_RALLAR_API_BASE_URL=http://127.0.0.1:8080 VITE_RALLAR_SPA_BASE_URL=http://127.0.0.1:5176 \
RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5180 \
npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts \
  tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts --retries=0
npx tsx apps/rallar-black-box/scripts/write-distributed-run-artifact-analysis.ts \
  --artifact-dir "$RALLAR_BLACK_BOX_STORAGE_DIR/observation"
```

The verdict is `observation/distributed-run.json` (`state`, `rollup.ok`, `rollup.summary`
with N/N participants and recipes and 231/231 passed group assertions); the analyzer
writes `observation/analysis/{summary,fix-proposal,performance}.md` beside it.

Retain the recorder directory after every attempt. GitHub always uploads
`all-local-alm-<run_id>-<run_attempt>` with runner resources/runtime versions,
source commit and digest, the source manifest and available native evidence.
Local provenance marks dirty source and hashes the measured files. Before all
registrations, no distributed run exists; evidence records that availability
boundary. After registration, the canonical operator exports snapshots, bundle,
results and events on success or failure. Recorder completeness compares exact
exported bytes, received counts and the latest-per-command snapshot inventory.

Acceptance requires terminal `passed`, `rollup.ok`, 15 distinct principals/clients,
the frozen roles, all 15 successful recipes and 231 passed group assertions with
zero failures or incomplete evidence. Worker exit zero or readable analysis alone
does not establish acceptance. Preserve any setup failure without changing auth,
readiness, barrier, workload or ACK limits. Fresh ephemeral PGlite, local pubsub/ICE,
loopback transport, co-located browsers and runtime version differences limit the
comparison; success cannot establish CPU-only causality or replace hosted scale proof.

## Prerequisites

- The Hetzner control server, API, and SPA are already deployed and reachable
  from GitHub-hosted runners.
- The workflow secrets are configured: `RALLAR_BLACK_BOX_USERNAME`,
  `RALLAR_BLACK_BOX_PASSWORD`, `HETZNER_SSH_PRIVATE_KEY`,
  `HETZNER_KNOWN_HOSTS`, `HETZNER_HOST`, and `HETZNER_USER`. For hardened
  control servers, also configure `RALLAR_BLACK_BOX_CONTROL_READ_TOKEN` with an
  admin/operator token; the workflow uses it to mint short-lived per-agent run
  tokens and to poll protected read endpoints. `RALLAR_BLACK_BOX_CONTROL_TOKEN`
  remains a legacy fallback for older deployments.
  `RALLAR_BLACK_BOX_USERNAME` remains required by the Hetzner operator reusable
  runner in both `prepare-hetzner` and `operator` phases. It is the reusable
  runner's operator credential, not a GitHub-hosted per-agent username; the
  `github-agents` job uses each global agent ID as that agent's username.
- Public endpoint inputs point at production or the intended staging target:
  `spa_url`, `api_base_url`, `control_url`, and `control_http_url`.
- The workflow always runs the immutable `${{ github.sha }}` associated with
  the workflow dispatch; it does not accept a caller-selected Git ref. The
  `production` environment must restrict deployment branches to the trusted
  production branch or branches so only commits from those branches can read
  production secrets.
- The selected manifest role map matches the workflow `agent_prefix`.
- GitHub Actions minutes are available. This repository is public, so standard
  GitHub-hosted runner minutes are not billed; the 2,000 included minutes per
  month apply only to private repositories. The binding limits are the roughly
  20 concurrent jobs per account shared with all CI (every agent shard must run
  at once, so a 50-agent run needs an otherwise idle account), the 4 vCPU /
  16 GiB standard runner, and the single shared concurrency group.

## Dispatch Values

Use these values for the 50-agent 30-second smoke:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json
target_agent_count=50
agents_per_job=3
max_parallel_jobs=17
agent_prefix=controller
ready_timeout_seconds=300
terminal_timeout_seconds=900
```

This creates 17 shards with agents_per_job=3. Shards 1 through 16 start three
agents each, and shard 17 starts the final two agents. The Hetzner operator job
runs concurrently, so Do not set max_parallel_jobs above 19 on GitHub Free.

The `prepare-hetzner` and `operator` jobs pass `agent_source=external` to the
reusable Hetzner runner, so it starts no Hetzner workers and waits for these
agents instead. Each GitHub agent shard runs
`npm --workspace rallar-black-box run worker:headless` with a 75-minute job
timeout and:

```text
RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal
RALLAR_BLACK_BOX_IDLE_EXIT_MS=4500000
RALLAR_AGENT_PROVIDER=github-actions
```

The worker exit mode makes each shard poll the target distributed run and exit
after it reaches `passed`, `failed`, `cancelled`, or `timed-out`.

Before launching a shard, the workflow calls
`POST /runs/{runId}/agents/{agentId}/tokens` for each local agent and exports
the returned values as `RALLAR_BLACK_BOX_AGENT_<N>_CONTROL_TOKEN`. It also
writes `RALLAR_BLACK_BOX_AGENT_<N>_USERNAME` using that global `agentId` and
the configured password as `RALLAR_BLACK_BOX_AGENT_<N>_PASSWORD`. Registration
(`register_before_login`) is enabled by default and required for every
multi-agent run (the `plan` job fails otherwise), so every global agent ID
registers and uses one distinct username. The short-lived run tokens are the only control tokens
forwarded into browser-agent URLs. The admin/operator read token stays in the
Node-side worker environment.

## Smoke Progression

1. Run the 2-agent health smoke first:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json
target_agent_count=2
agents_per_job=1
max_parallel_jobs=2
agent_prefix=controller
ready_timeout_seconds=180
terminal_timeout_seconds=300
```

2. Run a 10-agent 30-second tree smoke with
   `manifest_path=apps/rallar-black-box/manifests/hetzner/diagnostic/matrix/rtc-messages-principal-10-agent-30s-20hz-tree.json`,
   `target_agent_count=10`, `agents_per_job=2`, and `max_parallel_jobs=5`.
3. Run a 20-agent 30-second tree smoke with
   `manifest_path=apps/rallar-black-box/manifests/hetzner/diagnostic/matrix/rtc-messages-principal-20-agent-30s-20hz-tree.json`
   and `target_agent_count=20`.
4. Run the 50-agent 30-second tree smoke using the dispatch values above.
5. Run the 50-agent 60-minute tree,
   `apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json`,
   only after the 30-second run is stable and identity checks pass.

## ALM Scale Cohorts (manifests 19, 20 and 21)

Run each cohort locally first (the all-local rehearsal above) and dispatch it
through the workflow only after a local pass. In `hetzner-control` mode the
three cohorts need input changes only:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json
target_agent_count=15   agents_per_job=3   max_parallel_jobs=5
manifest_path=apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json
target_agent_count=30   agents_per_job=2   max_parallel_jobs=15
manifest_path=apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json
target_agent_count=50   agents_per_job=3   max_parallel_jobs=17
```

All three set `metadata.rtcTopologyEnv` (mesh min size N + 1), so
`rollout_control_plane=true` or `rollout_control_plane=preserve-public-settings`
is required, and `register_before_login=true`.
Hosted Hetzner agents now also sign in as one user per agent (`controller-NN`),
matching the all-local lifecycle and these shards, because one shared principal
fans every connect out to a full snapshot for each of its sessions and stalls
the 15-agent room join.
The 30- and 50-agent runs occupy 16 and 18 of the account's roughly 20
concurrent jobs, so dispatch them when no other workflow is running. TURN is
configured on the Hetzner plane, so cross-runner RTC edges form.

Agents on one host share one source IP, and the API admits 20 registrations
and 30 logins per IP per 60 s window by default
(`authentication.rateLimits.registrationIp` and `loginIp`), so a co-located
cohort above 20 agents is refused at its first sign-in. The all-local
lifecycle's API env block and the controller env written by
`02-deploy-controller.sh` raise both to 200 (50 agents, four auth requests
each per window); product defaults are unchanged. `08-rollout-controller.sh`
keeps the two settings but does not add them, so redeploy a controller set up
before this change. An `operator-spa` agent whose sign-in is refused now fails
the worker at start with the refusal text; a `headless` agent registers at its
recipe's first connection, where a refused registration still surfaces as that
login's 401.

In `all-local` mode only manifest 19 is a meaningful dispatch: the 4 vCPU
runner already fails the 15-agent window while 6 agents pass, and 30 or 50
browser contexts beside the API and control server exceed it. Carrying those
cohorts all-local would need a larger or self-hosted runner (a `runs-on` input)
and a production-built SPA instead of the Vite dev server; browsers cannot be
sharded across runners while the API stays on one runner's loopback.

## Prefix And Role Map

The default `agent_prefix=controller` exists because the current 50-agent
manifests target `controller-01` through `controller-50`. Before changing the
prefix, inspect the manifest role map and `roleAssignments[].agentId` values.
The workflow preflight fails when the manifest `expectedParticipantCount` differs
from `target_agent_count`, when a `role-map` manifest's unique IDs do not number
`target_agent_count`, or when a role ID is not `<agent_prefix>-NN` within
`1..target_agent_count`. It also requires `barrier.enabled=true` for 10 or more
agents and `metadata.recommendedTerminalTimeoutSeconds` for 60-minute manifests.

## Prepare Phase

The `prepare-hetzner` job runs before any GitHub agent job starts. It invokes
the reusable Hetzner runner with `operator_phase=prepare`,
`agent_source=external`, and `rollout_before_run` taken from the workflow's
`rollout_control_plane` choice (default `true`). Existing `true` and `false`
invocation values retain their behavior. The explicit
`preserve-public-settings` choice enables rollout while preserving the ten
validated public controller settings, so masked inspect values do not need to
be supplied again:

```text
rollout_control_plane=preserve-public-settings
```

The planner and prepare caller derive a rollout boolean from `true` or
`preserve-public-settings`; both prepare and run calls derive preservation only
from `preserve-public-settings`. The run phase still skips rollout. The `plan`
job rejects `rollout_control_plane=false` for a manifest that sets
`metadata.rtcTopologyEnv`, because those values are applied during rollout.
Using the existing choice keeps all 25 operational dispatch inputs available.
All-local jobs retain their existing local stack lifecycle.

This phase applies `metadata.rtcTopologyEnv` to the Hetzner API/control
environment and writes a remote prepare marker. The later operator run uses
`operator_phase=run`, skips rollout, validates the marker, waits for external
agents, and starts the distributed run. Do not bypass `prepare-hetzner` for
topology manifests, because restarting the API/control plane while GitHub
agents are connecting can invalidate the run.

## Minute Budget

The 50-agent 30-second smoke usually spends most of its GitHub Actions time on
runner setup, `npm ci`, Playwright browser installation, registration, and
artifact handling. The browser exercise itself is short.

The 50-agent 60-minute run uses roughly 17 one-hour agent shards plus one
operator job, about 1,080 job-minutes plus setup overhead. Re-check current
GitHub Actions limits before long runs or repeated retries.

## Artifacts

After the operator job finishes, download:

- `hetzner-distributed-<distributed_run_id>` for raw exported artifacts.
- `hetzner-distributed-analysis-<distributed_run_id>` for generated analysis.
- `hetzner-operation-<distributed_run_id>` for `operation-report.json`,
  `summary.md`, and `evidence.log`; read it first when the recipe never started.

The raw artifact directory should include `manifest.json`,
`distributed-run.json`, `distributed-artifact-bundle.json`, `events.jsonl`,
`results.jsonl`, `failures.json`, `control-run.json`, `fleet-report.json`,
and `runner-summary.json` when those files are available from the control
server.

For acceptance, inspect the artifacts and confirm:

- 50 unique `agentId` values, `controller-01` through `controller-50`.
- 50 unique `sessionId` values.
- 50 unique `auth.clientId` values or equivalent browser client identities.
- The role-map sender resolves to `controller-01`.
- The role-map receivers resolve to `controller-02` through `controller-50`.
- Connected agent metadata includes `RALLAR_AGENT_PROVIDER=github-actions`.

Each global `agentId` must have one registered username and a distinct browser
principal. The workflow supplies the existing per-agent
`RALLAR_BLACK_BOX_AGENT_N_USERNAME` and
`RALLAR_BLACK_BOX_AGENT_N_PASSWORD` values for every shard.

## Common Failures

- Actions concurrency: reduce `max_parallel_jobs`, or wait for other workflows
  to finish.
- Monthly minute exhaustion: use the 2-agent and 10-agent smokes until the next
  billing window or a higher allowance is available.
- Registration timeout: confirm the public SPA, API, and control URLs are
  reachable from GitHub-hosted runners, credentials are valid, and the
  `RALLAR_BLACK_BOX_CONTROL_READ_TOKEN` secret can mint per-agent run tokens
  when control-server hardening is enabled.
- TURN or ICE issues: inspect fleet and RTC artifacts before rerunning larger
  smokes.
- Manifest count mismatch: set `target_agent_count` to the manifest
  `targetPolicy.expectedParticipantCount`, or choose the matching manifest.
- Role-map prefix mismatch: keep `agent_prefix=controller` unless the manifest
  role map is changed too.
- Topology prepare marker failure: re-run all jobs of the workflow with the
  same ref and manifest so `prepare-hetzner` writes a fresh marker before the
  operator run; `prepare-hetzner` is a job of this workflow, not a separate
  dispatch.
- Barrier timeout: retain native command delivery and readiness evidence and
  investigate the demonstrated boundary before rerunning. The frozen all-local
  observation keeps its 15-second coordinator start barrier and does not create a relaxed fixture.

## Cleanup

No Hetzner headless systemd worker stop is needed in `external` mode because
GitHub-hosted agents run inside GitHub Actions jobs. The reusable runner skips
the Hetzner headless stop when `agent_source=external`. If a run fails before
agent registration, cancel any still-running GitHub agent matrix jobs from the
workflow page.
