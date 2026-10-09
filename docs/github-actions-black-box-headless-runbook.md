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

For a local rehearsal, allocate fresh recorder storage before services start:

```sh
mkdir -p tmp/alm-v1c
ALM_LOCAL_RECORDER_DIR="$(mktemp -d "$PWD/tmp/alm-v1c/all-local-recorder.XXXXXX")"
CI=1 RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_FULL_STACK_HEADLESS=1 RALLAR_BLACK_BOX_API_MODE=memory RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=16 RALLAR_BLACK_BOX_STORAGE_DIR="$ALM_LOCAL_RECORDER_DIR" RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS=unbounded RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS=unbounded npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts --retries=0
```

Retain the recorder directory after every attempt. GitHub always uploads
`all-local-alm-<run_id>-<run_attempt>` with runner resources/runtime versions,
source commit and digest, the source manifest and available native evidence.
Local provenance marks dirty source and hashes the measured files. Before all
registrations, no distributed run exists; evidence records that availability
boundary. After registration, the canonical operator exports snapshots, bundle,
results and events on success or failure. Recorder completeness compares exact
exported bytes, received counts and the latest-per-command snapshot inventory.

Acceptance requires terminal `passed`, `rollup.ok`, 15 distinct principals/clients,
the frozen roles, all 15 successful recipes and 73 passed group assertions with
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
- GitHub Actions minutes are available. GitHub Free includes 2,000 included minutes
  per month for private repositories, and long 50-agent runs can use a large
  share of that quickly.

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
`rollout_control_plane` input (default `true`). The `plan` job rejects
`rollout_control_plane=false` for a manifest that sets
`metadata.rtcTopologyEnv`, because those values are applied during rollout.

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
  observation keeps its 15-second barrier and does not create a relaxed fixture.

## Cleanup

No Hetzner headless systemd worker stop is needed in `external` mode because
GitHub-hosted agents run inside GitHub Actions jobs. The reusable runner skips
the Hetzner headless stop when `agent_source=external`. If a run fails before
agent registration, cancel any still-running GitHub agent matrix jobs from the
workflow page.
