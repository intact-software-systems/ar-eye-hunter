# GitHub Free Rallar Black Box Headless Runbook

This runbook is for manual validation of
`.github/workflows/github-free-distributed-recipe.yml`. It starts
GitHub-hosted headless browser shards, reuses the public Hetzner control/API
environment, and lets the Hetzner operator stage, start, export, and analyze
the distributed run.

## Prerequisites

- The Hetzner control server, API, and SPA are already deployed and reachable
  from GitHub-hosted runners.
- The workflow secrets are configured: `RALLAR_BLACK_BOX_USERNAME`,
  `RALLAR_BLACK_BOX_PASSWORD`, `RALLAR_BLACK_BOX_CONTROL_TOKEN`,
  `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_KNOWN_HOSTS`, `HETZNER_HOST`, and
  `HETZNER_USER`.
- Public endpoint inputs point at production or the intended staging target:
  `spa_url`, `api_base_url`, `control_url`, and `control_http_url`.
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

The GitHub agent jobs use:

```text
agent_source=external
RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal
```

The worker exit mode makes each shard poll the target distributed run and exit
after it reaches `passed`, `failed`, `cancelled`, or `timed-out`.

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

2. Run a 10-agent 30-second tree smoke with `agents_per_job=2` and
   `max_parallel_jobs=5`.
3. Run a 20-agent 30-second tree smoke.
4. Run the 50-agent 30-second tree smoke using the dispatch values above.
5. Run the 50-agent 60-minute tree only after the 30-second run is stable and
   identity checks pass.

## Prefix And Role Map

The default `agent_prefix=controller` exists because the current 50-agent
manifests target `controller-01` through `controller-50`. Before changing the
prefix, inspect the manifest role map and `roleAssignments[].agentId` values.
The workflow preflight fails when the unique role-map IDs do not match
`target_agent_count` or when an ID uses the wrong prefix.

## Prepare Phase

The `prepare-hetzner` job runs before any GitHub agent job starts. It invokes
the reusable Hetzner runner with `operator_phase=prepare`,
`agent_source=external`, and `rollout_before_run=true`.

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

If shared username/password credentials collapse multiple browser sessions into
one client identity, stop before the 60-minute run and wire the existing
per-agent `RALLAR_BLACK_BOX_AGENT_N_USERNAME` and
`RALLAR_BLACK_BOX_AGENT_N_PASSWORD` values.

## Common Failures

- Actions concurrency: reduce `max_parallel_jobs`, or wait for other workflows
  to finish.
- Monthly minute exhaustion: use the 2-agent and 10-agent smokes until the next
  billing window or a higher allowance is available.
- Registration timeout: confirm the public SPA, API, and control URLs are
  reachable from GitHub-hosted runners and that credentials are valid.
- TURN or ICE issues: inspect fleet and RTC artifacts before rerunning larger
  smokes.
- Manifest count mismatch: set `target_agent_count` to the manifest
  `targetPolicy.expectedParticipantCount`, or choose the matching manifest.
- Role-map prefix mismatch: keep `agent_prefix=controller` unless the manifest
  role map is changed too.
- Topology prepare marker failure: rerun the same ref and manifest through
  `prepare-hetzner` before the operator run.
- Short barrier timeout: the current 50-agent smoke uses
  `barrier.timeoutMs=15000`. If all agents connect but staged command delivery
  misses the barrier, create a GitHub-specific manifest copy that changes only
  `distributedRunId`, display/catalog labels, and `barrier.timeoutMs=60000`.

## Cleanup

No Hetzner headless systemd worker stop is needed in `external` mode because
GitHub-hosted agents run inside GitHub Actions jobs. The reusable runner skips
the Hetzner headless stop when `agent_source=external`. If a run fails before
agent registration, cancel any still-running GitHub agent matrix jobs from the
workflow page.
