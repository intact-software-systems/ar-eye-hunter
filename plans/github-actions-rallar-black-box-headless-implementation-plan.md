# GitHub Actions Rallar Black Box Headless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `rallar-black-box` headless browser control agents from GitHub Actions under GitHub Free constraints, while reusing the existing Hetzner control server, distributed-run orchestration, barrier start, artifact export, and analysis pipeline.

**Architecture:** Use Option A. A new GitHub Free distributed recipe workflow first prepares the Hetzner control/API environment for the selected manifest, then starts a matrix of GitHub-hosted headless-worker jobs and a concurrent Hetzner operator job. The operator waits for those external agents, stages the distributed run, starts it through the existing control server APIs, and collects artifacts from Hetzner. The existing Hetzner controller/deploy workflow remains the way to run the public control server; the distributed recipe runner gains external-agent and prepare/run phase support instead of assuming all agents are systemd workers on the Hetzner VM.

**Tech Stack:** GitHub Actions reusable/manual workflows, Bash, Node 20, npm workspaces, Playwright Chromium, `apps/rallar-black-box/scripts/headless-worker.ts`, `apps/rallar-black-box-control-server`, `scripts/hetzner/controller/*.sh`, Vitest source-inspection tests.

## Global Constraints

- GitHub Free default target: at most 20 total concurrent GitHub-hosted jobs for this workflow.
- Reserve one concurrent GitHub-hosted job for the Hetzner operator while agents are running, so the GitHub agent matrix must default to and validate `max_parallel_jobs <= 19` under GitHub Free constraints.
- GitHub Free currently allows 20 concurrent standard GitHub-hosted jobs, 2,000 included minutes per month, and 500 MB artifact storage for the Free plan. Re-check <https://docs.github.com/en/actions/reference/limits> before increasing defaults because GitHub marks these limits as subject to change.
- Default sharding must support 50 Rallar agents with fewer than 20 jobs, for example 17 jobs with `agents_per_job=3` where the first 16 shards run 3 agents and the final shard runs 2 agents.
- The default 50-agent manifest uses role-map agent IDs `controller-01` through `controller-50`; the GitHub Free workflow must default `agent_prefix=controller` unless it also rewrites or validates a manifest with a different prefix.
- GitHub agent jobs must connect outbound to the public Hetzner control server over WSS and API/SPA over HTTPS.
- The first implementation should keep Hetzner as the control server and artifact collection host.
- Existing Hetzner controller deployment should be reused as-is unless a task explicitly states a narrow extension.
- Manifests with `metadata.rtcTopologyEnv` must apply the Hetzner/API topology environment before any GitHub agents connect; do not let agents start while the API/control plane is rolling.
- The reusable Hetzner runner must check out `inputs.ref` before copying scripts or manifests; otherwise the GitHub workflow can dispatch one ref while the operator uses files from another.
- A split `prepare`/`run` operator flow must write and validate a remote prepare marker for topology manifests so `operator_phase=run` can safely skip rollout without bypassing topology validation accidentally.
- Use barrier-enabled or scheduled distributed manifests so GitHub-hosted agents can finish registering before recipe start.
- Worker terminal polling must tolerate the target distributed run returning `404` before the operator creates it.
- Acceptance artifacts must prove that all expected agents have unique `agentId`, `sessionId`, and `auth.clientId`/client identity values.
- Do not expose admin, operator, run-token, username, or password secrets through `VITE_*` values.
- Preserve existing public exports, app import paths, and Hetzner workflows unless the task explicitly adds a compatible input.
- Keep generated run artifacts out of git.

---

## Source Inputs Inspected

- `AGENTS.md` instructions from the conversation.
- `skills/rallar-platform/SKILL.md`
- `skills/rallar-realtime/SKILL.md`
- `skills/rallar-testing/SKILL.md`
- `skills/rallar-testing/references/test-commands.md`
- GitHub Actions limits documentation: <https://docs.github.com/en/actions/reference/limits>
- `playground/FREE_TIER_HEADLESS_BROWSER_DISTRIBUTED_RECIPES.md`
- `.github/workflows/hetzner-headless-browsers.yml`
- `.github/workflows/hetzner-distributed-recipe.yml`
- `.github/workflows/hetzner-distributed-recipe-runner.yml`
- `scripts/hetzner/controller/09-start-headless-workers.sh`
- `scripts/hetzner/controller/10-stop-headless-workers.sh`
- `scripts/hetzner/controller/14-run-distributed-recipe.sh`
- `scripts/hetzner/controller/README.md`
- `apps/rallar-black-box/scripts/headless-worker.ts`
- `apps/rallar-black-box/src/headless-worker-config.ts`
- `apps/rallar-black-box/package.json`
- `apps/rallar-black-box-headless/package.json`
- `packages/shared-test/rallar-bb-test/distributed-run.ts`
- `packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`
- `apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json`
- `apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json`
- `packages/tests/hetzner/distributed-recipe-workflow.test.ts`
- `packages/tests/rallar-black-box/headless-worker-config.test.ts`
- `packages/tests/rallar-black-box/headless-worker-script.test.ts`
- `docs/environment-variables.md`

## Decisions

- Implement Option A: GitHub-hosted agent pool plus existing Hetzner operator/control plane.
- Make GitHub Free the default: agent-matrix `max-parallel` must not exceed 19 because the operator consumes one concurrent hosted-job slot, and the workflow should encourage sharding multiple agents per job.
- Build one top-level workflow first, not two manually coordinated dispatches. The workflow has a planning job, a Hetzner prepare job, a GitHub agent matrix job, and a concurrent Hetzner operator run job. This keeps shared `run_id`, `distributed_run_id`, `agent_prefix`, and manifest inputs in one execution while ensuring topology rollout completes before external agents connect.
- Extend the existing Hetzner distributed recipe runner with an external-agent mode. Do not duplicate the stage/start/artifact logic in a second operator implementation.
- Extend the existing Hetzner distributed recipe runner with explicit `prepare` and `run` phases. The default `full` phase preserves existing Hetzner-only behavior.
- In `prepare` phase, write a remote prepare marker keyed by distributed run id, selected ref, manifest checksum, and topology env. In `run` phase, validate that marker before allowing topology manifests to skip rollout.
- Add clean worker exit support before relying on long-running GitHub jobs. GitHub jobs should exit when the distributed run becomes terminal, with an idle timeout as a fallback.
- Use the existing `RALLAR_BLACK_BOX_AGENT_START_INDEX` support to create deterministic agent IDs across shards. Default `agent_prefix=controller` so the GitHub agents match the existing role-map manifests; any other prefix must be proven compatible by preflight.
- Keep `apps/rallar-black-box-headless` terminology out of commands where it would be misleading. GitHub jobs run `npm --workspace rallar-black-box run worker:headless`, which opens the `/headless/` browser entry.

## Non-Goals

- No replacement of the Hetzner control server deployment.
- No paid GitHub Team/Enterprise-only path as the default.
- No Cloudflare Browser Run, Browserless, Cloud Run, or Azure Container Apps implementation in this plan.
- No new distributed recipe format.
- No SFU, TURN, topology, or group-tree algorithm changes.
- No automatic GitHub workflow dispatch from the control server.

## File Structure By Responsibility

- `apps/rallar-black-box/src/headless-worker-config.ts`: parse GitHub-friendly exit-mode and distributed-run polling config.
- `apps/rallar-black-box/scripts/headless-worker.ts`: keep browser agents alive until signal, idle timeout, or target distributed run terminal state.
- `scripts/github-actions/plan-github-free-headless-matrix.mjs`: validate GitHub Free sizing inputs and emit deterministic shard matrix JSON.
- `scripts/hetzner/controller/16-wait-for-control-agents.sh`: provider-neutral wait helper for externally started control agents.
- `scripts/hetzner/controller/14-run-distributed-recipe.sh`: continues to create, stage, start, wait, and export distributed-run artifacts.
- `.github/workflows/hetzner-distributed-recipe-runner.yml`: adds external-agent mode, prepare/run phases, and calls the new wait helper instead of always starting Hetzner systemd workers.
- `.github/workflows/github-free-distributed-recipe.yml`: new manual workflow that prepares Hetzner first, then starts GitHub-hosted agent shards and the Hetzner operator concurrently.
- `packages/tests/rallar-black-box/headless-worker-config.test.ts`: config tests for exit/idle/target run settings.
- `packages/tests/rallar-black-box/headless-worker-script.test.ts`: source-level tests for terminal polling, redaction, and shutdown behavior.
- `packages/tests/hetzner/distributed-recipe-workflow.test.ts`: workflow/script source tests for external-agent operator mode.
- `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`: source tests for the new GitHub Free workflow.
- `docs/environment-variables.md`: documents new worker and workflow env vars.
- `scripts/hetzner/controller/README.md`: documents external GitHub agent pool operation.

## Iteration 1: Headless Worker Exit And Lease Controls

Goal: allow GitHub-hosted headless-worker jobs to terminate cleanly after a distributed run, rather than hanging until the workflow timeout.

### Task 1: Extend Headless Worker Config

**Files:**

- Modify: `apps/rallar-black-box/src/headless-worker-config.ts`
- Modify: `packages/tests/rallar-black-box/headless-worker-config.test.ts`
- Modify: `docs/environment-variables.md`

**Interfaces:**

- Produces type:

```ts
export type HeadlessWorkerExitMode =
  | "signal"
  | "after-target-distributed-run-terminal"
  | "after-idle-ms";
```

- Produces config fields:

```ts
exitMode: HeadlessWorkerExitMode;
targetDistributedRunId?: string;
controlHttpUrl?: string;
idleExitMs?: number;
distributedPollIntervalMs: number;
```

- Consumes existing `controlRunSnapshotUrlFromControlUrl(controlUrl, runId)`.

- [x] **Step 1: Write config tests**

Add tests that assert:

```ts
const config = readHeadlessWorkerConfig({
  env: {
    RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
    RALLAR_BLACK_BOX_CONTROL_URL: "wss://control.example.test/control",
    RALLAR_API_BASE_URL: "https://api.example.test",
    RALLAR_BLACK_BOX_RUN_ID: "run-1",
    RALLAR_BLACK_BOX_ROOM_ID: "room-1",
    RALLAR_BLACK_BOX_USERNAME: "alice",
    RALLAR_BLACK_BOX_PASSWORD: "secret",
    RALLAR_BLACK_BOX_EXIT_MODE: "after-target-distributed-run-terminal",
    RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID: "dist-run-1",
    RALLAR_CONTROL_HTTP_URL: "https://control.example.test",
    RALLAR_BLACK_BOX_DISTRIBUTED_POLL_INTERVAL_MS: "2500",
  },
});

expect(config.exitMode).toBe("after-target-distributed-run-terminal");
expect(config.targetDistributedRunId).toBe("dist-run-1");
expect(config.controlHttpUrl).toBe("https://control.example.test");
expect(config.distributedPollIntervalMs).toBe(2500);
```

Also assert:

```ts
expect(readHeadlessWorkerConfig({ env: baseEnv }).exitMode).toBe("signal");
expect(() => readHeadlessWorkerConfig({
  env: Object.assign({}, baseEnv, { RALLAR_BLACK_BOX_EXIT_MODE: "forever" }),
}))
  .toThrow("RALLAR_BLACK_BOX_EXIT_MODE must be signal, after-target-distributed-run-terminal, or after-idle-ms");
expect(() => readHeadlessWorkerConfig({
  env: Object.assign({}, baseEnv, {
    RALLAR_BLACK_BOX_EXIT_MODE: "after-idle-ms",
    RALLAR_BLACK_BOX_IDLE_EXIT_MS: "0",
  }),
}))
  .toThrow("RALLAR_BLACK_BOX_IDLE_EXIT_MS must be a positive integer");
```

- [x] **Step 2: Run config tests and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts
```

Expected before implementation: FAIL because `exitMode` fields are missing.

- [x] **Step 3: Implement config parsing**

Add the type, defaults, parsing helpers, and config fields. Use:

```ts
const DEFAULT_EXIT_MODE: HeadlessWorkerExitMode = "signal";
const DEFAULT_DISTRIBUTED_POLL_INTERVAL_MS = 5_000;
```

Parse:

- `RALLAR_BLACK_BOX_EXIT_MODE`
- `RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID`
- `RALLAR_CONTROL_HTTP_URL`
- `RALLAR_BLACK_BOX_IDLE_EXIT_MS`
- `RALLAR_BLACK_BOX_DISTRIBUTED_POLL_INTERVAL_MS`

For `after-target-distributed-run-terminal`, require `RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID`. Derive `controlHttpUrl` from `RALLAR_CONTROL_HTTP_URL` when set, otherwise from `RALLAR_BLACK_BOX_CONTROL_URL` by converting `ws:` to `http:` and `wss:` to `https:`.

- [x] **Step 4: Document config**

In `docs/environment-variables.md`, under the Rallar Black Box Headless Worker section, add rows for the new variables with defaults and GitHub Actions usage.

- [x] **Step 5: Run config verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/rallar-black-box/src/headless-worker-config.ts packages/tests/rallar-black-box/headless-worker-config.test.ts docs/environment-variables.md
git commit -m "feat: add headless worker exit config"
```

### Task 2: Implement Terminal Polling In The Worker

**Files:**

- Modify: `apps/rallar-black-box/scripts/headless-worker.ts`
- Modify: `packages/tests/rallar-black-box/headless-worker-script.test.ts`

**Interfaces:**

- Consumes `HeadlessWorkerConfig.exitMode`, `targetDistributedRunId`, `controlHttpUrl`, `idleExitMs`, and `distributedPollIntervalMs`.
- Produces helper behavior:
  - `signal`: current behavior.
  - `after-idle-ms`: resolves after the configured idle period.
  - `after-target-distributed-run-terminal`: polls `/distributed-runs/{id}` until `passed`, `failed`, `cancelled`, or `timed-out`.

- [x] **Step 1: Write source tests**

Add assertions that `headless-worker.ts` contains:

```ts
const TERMINAL_DISTRIBUTED_RUN_STATES = new Set(["passed", "failed", "cancelled", "timed-out"]);
```

and calls a helper equivalent to:

```ts
await waitForWorkerExit(config, shutdown);
```

Also assert URL redaction covers `controlToken`, `rallarPassword`, `rallarToken`, and any key matching `/token|password|secret/i`.

Add one assertion that terminal polling treats a missing distributed run as a waiting state, because GitHub agents can start before the operator creates the run:

```ts
expect(script).toContain("Distributed run dist-run-1 is not created yet");
expect(script).toContain("response.status === 404");
```

- [x] **Step 2: Run worker script tests and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/headless-worker-script.test.ts
```

Expected before implementation: FAIL because terminal polling helpers are missing.

- [x] **Step 3: Implement exit helpers**

Add helpers:

```ts
async function waitForWorkerExit(
  config: HeadlessWorkerConfig,
  shutdown: Readonly<{ wait(): Promise<void> }>,
): Promise<void>
```

```ts
async function waitForDistributedRunTerminal(config: HeadlessWorkerConfig): Promise<void>
```

```ts
function distributedRunUrl(config: HeadlessWorkerConfig): string
```

Use `Promise.race([shutdown.wait(), waitForDistributedRunTerminal(config)])` for terminal mode so SIGTERM still exits promptly. Log each observed distributed-run state change. If `/distributed-runs/{id}` returns `404`, log once per state transition as "not created yet" and keep polling until the idle timeout or a terminal state. Fail fast on `401` or `403` because those indicate bad GitHub/operator token configuration. Treat malformed JSON as retryable for three consecutive polls, then throw with a redacted URL.

- [x] **Step 4: Run worker verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/headless-worker-script.test.ts packages/tests/rallar-black-box/headless-worker-config.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/rallar-black-box/scripts/headless-worker.ts packages/tests/rallar-black-box/headless-worker-script.test.ts
git commit -m "feat: stop headless workers after distributed runs"
```

## Iteration 2: External Agent Wait Support For Hetzner Operator

Goal: reuse the existing Hetzner operator path while allowing agents to be started by GitHub Actions.

### Task 3: Add External Control-Agent Wait Script

**Files:**

- Create: `scripts/hetzner/controller/16-wait-for-control-agents.sh`
- Modify: `packages/tests/hetzner/distributed-recipe-workflow.test.ts`
- Modify: `scripts/hetzner/controller/README.md`

**Interfaces:**

- Consumes environment:

```bash
RALLAR_BLACK_BOX_CONTROL_URL
RALLAR_BLACK_BOX_RUN_ID
RALLAR_BLACK_BOX_AGENT_PREFIX
RALLAR_BLACK_BOX_AGENT_COUNT
RALLAR_BLACK_BOX_AGENT_START_INDEX
RALLAR_HEADLESS_READY_TIMEOUT_SECONDS
```

- Produces exit code 0 when at least `RALLAR_BLACK_BOX_AGENT_COUNT` connected agents match the prefix and ordinal range.

- [ ] **Step 1: Write source test**

Extend `packages/tests/hetzner/distributed-recipe-workflow.test.ts` to assert:

```ts
const script = await readFile(path.join(repoRoot, "scripts/hetzner/controller/16-wait-for-control-agents.sh"), "utf8");
expect(script).toContain("RALLAR_BLACK_BOX_AGENT_START_INDEX");
expect(script).toContain("control_run_snapshot_url");
expect(script).toContain("Timed out waiting for external control agents");
expect(script).not.toContain("systemctl is-active");
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run packages/tests/hetzner/distributed-recipe-workflow.test.ts
```

Expected before implementation: FAIL because the script does not exist.

- [ ] **Step 3: Implement script**

Extract the control snapshot URL and connected-agent counting logic from `09-start-headless-workers.sh`, but remove systemd checks. Keep the same prefix/start-index semantics:

```bash
agent_start="${RALLAR_BLACK_BOX_AGENT_START_INDEX}"
agent_end="$((agent_start + expected - 1))"
```

Use `jq` to count connected agents whose `agentId` starts with `${RALLAR_BLACK_BOX_AGENT_PREFIX}-` and whose numeric suffix is within the expected range.

- [ ] **Step 4: Document script**

In `scripts/hetzner/controller/README.md`, add a short section "External GitHub agent pools" showing:

```bash
RALLAR_BLACK_BOX_CONTROL_URL=wss://control.rallar.intactss.com/control \
RALLAR_BLACK_BOX_RUN_ID=gh-123 \
RALLAR_BLACK_BOX_AGENT_PREFIX=controller \
RALLAR_BLACK_BOX_AGENT_COUNT=50 \
RALLAR_BLACK_BOX_AGENT_START_INDEX=1 \
RALLAR_HEADLESS_READY_TIMEOUT_SECONDS=240 \
./16-wait-for-control-agents.sh
```

- [ ] **Step 5: Run verification**

Run:

```bash
npx vitest run packages/tests/hetzner/distributed-recipe-workflow.test.ts
git diff --check -- scripts/hetzner/controller/16-wait-for-control-agents.sh scripts/hetzner/controller/README.md
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/hetzner/controller/16-wait-for-control-agents.sh scripts/hetzner/controller/README.md packages/tests/hetzner/distributed-recipe-workflow.test.ts
git commit -m "feat: wait for external black-box agents"
```

### Task 4: Add External-Agent Mode To Hetzner Distributed Runner

**Files:**

- Modify: `.github/workflows/hetzner-distributed-recipe-runner.yml`
- Modify: `.github/workflows/hetzner-distributed-recipe.yml`
- Modify: `packages/tests/hetzner/distributed-recipe-workflow.test.ts`

**Interfaces:**

- Adds workflow input:

```yaml
agent_source:
  description: Agent source for the distributed run
  required: false
  type: string
  default: hetzner
operator_phase:
  description: Hetzner distributed recipe runner phase
  required: false
  type: string
  default: full
```

Allowed values:

- `hetzner`: current behavior.
- `external`: do not start or stop Hetzner headless workers; wait for external agents.
- `mixed`: start Hetzner workers and also wait for external agents. This is optional in the first workflow but should validate cleanly.

Allowed `operator_phase` values:

- `full`: current behavior; prepare the environment, start/wait for agents, run recipe, collect artifacts.
- `prepare`: copy scripts/manifest, render remote env, apply `rollout_before_run` and `metadata.rtcTopologyEnv`, verify control/API readiness, then exit without waiting for agents or starting a recipe.
- `run`: copy scripts/manifest, render remote env, skip API rollout, wait for agents according to `agent_source`, run recipe, and collect artifacts.

- [ ] **Step 1: Write workflow tests**

Add assertions:

```ts
expect(runnerWorkflow).toContain("agent_source:");
expect(runnerWorkflow).toContain("operator_phase:");
expect(runnerWorkflow).toContain("ref: ${{ inputs.ref }}");
expect(runnerWorkflow).toContain("RALLAR_BLACK_BOX_AGENT_SOURCE");
expect(runnerWorkflow).toContain("RALLAR_HETZNER_OPERATOR_PHASE");
expect(runnerWorkflow).toContain("RALLAR_DISTRIBUTED_PREPARE_MARKER");
expect(runnerWorkflow).toContain("./16-wait-for-control-agents.sh");
expect(runnerWorkflow).toContain('case "${RALLAR_BLACK_BOX_AGENT_SOURCE}" in');
expect(runnerWorkflow).toContain('case "${RALLAR_HETZNER_OPERATOR_PHASE}" in');
expect(runnerWorkflow).toContain("inputs.operator_phase != 'prepare'");
```

Assert that existing `hetzner` behavior still contains:

```ts
expect(runnerWorkflow).toContain("RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh");
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/tests/hetzner/distributed-recipe-workflow.test.ts
```

Expected before implementation: FAIL because `agent_source` is missing.

- [ ] **Step 3: Add workflow inputs**

Add `agent_source` and `operator_phase` to the manual wrapper and reusable runner. Pass through:

```yaml
agent_source: ${{ inputs.agent_source }}
operator_phase: ${{ inputs.operator_phase }}
```

Validate in Bash:

```bash
case "${RALLAR_BLACK_BOX_AGENT_SOURCE}" in
  hetzner|external|mixed) ;;
  *) echo "::error::agent_source must be hetzner, external, or mixed." >&2; exit 1 ;;
esac
case "${RALLAR_HETZNER_OPERATOR_PHASE}" in
  full|prepare|run) ;;
  *) echo "::error::operator_phase must be full, prepare, or run." >&2; exit 1 ;;
esac
```

- [ ] **Step 4: Check out the selected ref**

Update the reusable runner checkout step so `inputs.ref` controls the scripts, manifests, and analysis code used by the operator:

```yaml
- name: Checkout repo
  uses: actions/checkout@v4
  with:
    ref: ${{ inputs.ref }}
```

Keep the manual wrapper passing `ref: ${{ inputs.ref }}` into the reusable runner. Without this, a dispatch can roll out one ref on Hetzner while copying a manifest or controller script from the workflow's current branch.

- [ ] **Step 5: Split prepare and run behavior**

Keep existing behavior in `operator_phase=full`. In `operator_phase=prepare`, run the existing checkout/copy/env/render/rollout/readiness setup and exit before the headless-agent wait or distributed recipe start. This phase is what the GitHub Free workflow uses before starting any external browser jobs, so topology env changes are applied while no GitHub agents are connected.

In `operator_phase=run`, skip API rollout and do only the agent wait plus distributed recipe start/export. If the manifest has `metadata.rtcTopologyEnv`, the workflow must already have run `operator_phase=prepare` for the same `ref`, `manifest_path`, `run_id`, `application_id`, `workspace_id`, and `room_id`.

Change the manifest validation so topology env still requires rollout in `full` and `prepare`, but allows `run` only when a remote prepare marker is later validated:

```bash
if topology_env_requires_rollout &&
  [[ "${RALLAR_HETZNER_OPERATOR_PHASE}" != "run" ]] &&
  ! bool_enabled "${INPUT_ROLLOUT_BEFORE_RUN}"; then
  echo "::error::Manifest ${MANIFEST_PATH} requires rollout_before_run=true unless operator_phase=run validates a prepare marker." >&2
  exit 1
fi
```

- [ ] **Step 6: Add prepare marker validation**

Render a marker path into the remote env:

```bash
RALLAR_DISTRIBUTED_PREPARE_MARKER=/tmp/rallar-distributed-prepare-${RALLAR_DISTRIBUTED_RUN_ID}.json
```

In `operator_phase=prepare`, after rollout/readiness has succeeded and before exiting, write a marker that proves what was prepared:

```bash
manifest_sha="$(sha256sum "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" | awk '{print $1}')"
jq -n \
  --arg runId "${RALLAR_DISTRIBUTED_RUN_ID}" \
  --arg ref "${RALLAR_REPO_REF}" \
  --arg manifestSha "${manifest_sha}" \
  --arg degreeLimit "${RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT:-}" \
  --arg treeMinSize "${RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE:-}" \
  --arg meshMinSize "${RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE:-}" \
  --arg meshParamK "${RALLAR_RTC_TOPOLOGY_MESH_PARAM_K:-}" \
  --arg rttRebuildDebounceMs "${RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS:-}" \
  '{
    runId: $runId,
    ref: $ref,
    manifestSha: $manifestSha,
    rtcTopologyEnv: {
      RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: $degreeLimit,
      RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: $treeMinSize,
      RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: $meshMinSize,
      RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: $meshParamK,
      RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS: $rttRebuildDebounceMs
    }
  }' > "${RALLAR_DISTRIBUTED_PREPARE_MARKER}"
```

In `operator_phase=run`, when any topology env value is non-empty, require the marker to exist and match the current `RALLAR_REPO_REF` and manifest checksum before waiting for external agents:

```bash
remote_topology_env_requires_rollout() {
  [[ -n "${RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT:-}" ||
    -n "${RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE:-}" ||
    -n "${RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE:-}" ||
    -n "${RALLAR_RTC_TOPOLOGY_MESH_PARAM_K:-}" ||
    -n "${RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS:-}" ]]
}

if remote_topology_env_requires_rollout && [[ "${RALLAR_HETZNER_OPERATOR_PHASE}" == "run" ]]; then
  if [[ ! -s "${RALLAR_DISTRIBUTED_PREPARE_MARKER}" ]]; then
    echo "Missing prepare marker ${RALLAR_DISTRIBUTED_PREPARE_MARKER}; run prepare phase before external agents." >&2
    exit 1
  fi
  expected_manifest_sha="$(sha256sum "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" | awk '{print $1}')"
  jq -e \
    --arg ref "${RALLAR_REPO_REF}" \
    --arg manifestSha "${expected_manifest_sha}" \
    --arg degreeLimit "${RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT:-}" \
    --arg treeMinSize "${RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE:-}" \
    --arg meshMinSize "${RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE:-}" \
    --arg meshParamK "${RALLAR_RTC_TOPOLOGY_MESH_PARAM_K:-}" \
    --arg rttRebuildDebounceMs "${RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS:-}" \
    '.ref == $ref and
      .manifestSha == $manifestSha and
      .rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT == $degreeLimit and
      .rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE == $treeMinSize and
      .rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE == $meshMinSize and
      .rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_PARAM_K == $meshParamK and
      .rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS == $rttRebuildDebounceMs' \
    "${RALLAR_DISTRIBUTED_PREPARE_MARKER}" >/dev/null
fi
```

- [ ] **Step 7: Change remote execution branch**

In the remote `Run distributed recipe` step:

```bash
if [[ "${RALLAR_HETZNER_OPERATOR_PHASE}" == "prepare" ]]; then
  echo "Hetzner prepare phase complete; skipping agent wait and distributed run."
  exit 0
fi

case "${RALLAR_BLACK_BOX_AGENT_SOURCE}" in
  hetzner)
    ./10-stop-headless-workers.sh || true
    RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh
    ;;
  external)
    ./16-wait-for-control-agents.sh
    ;;
  mixed)
    RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh
    ./16-wait-for-control-agents.sh
    ;;
esac
./14-run-distributed-recipe.sh
```

Keep `stop_after_run` from stopping GitHub-hosted agents in `external` mode. Only call `./10-stop-headless-workers.sh` on cleanup when `agent_source` is `hetzner` or `mixed`.

- [ ] **Step 8: Skip recipe artifacts during prepare phase**

Guard artifact copy/upload, analysis, and failure propagation steps so `operator_phase=prepare` does not upload empty distributed-run artifacts or analyze a run that was intentionally not started. Use concrete conditions:

```yaml
if: always() && inputs.operator_phase != 'prepare'
```

For analysis steps that already require copied artifacts, use:

```yaml
if: always() && inputs.operator_phase != 'prepare' && steps.artifact_status.outputs.available == 'true'
```

For the final failure propagation step, use:

```yaml
if: always() && inputs.operator_phase != 'prepare' && steps.run_recipe.outcome != 'success'
```

Use that condition on:

- `Copy distributed artifacts`
- `Upload distributed artifacts`
- `Check distributed artifact availability`
- `Setup Node for analysis`
- `Install dependencies for analysis`
- `Analyze distributed artifacts`
- `Publish distributed analysis summary`
- `Upload distributed analysis`
- `Fail if distributed recipe failed`

- [ ] **Step 9: Run verification**

Run:

```bash
npx vitest run packages/tests/hetzner/distributed-recipe-workflow.test.ts
git diff --check -- .github/workflows/hetzner-distributed-recipe.yml .github/workflows/hetzner-distributed-recipe-runner.yml
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add .github/workflows/hetzner-distributed-recipe.yml .github/workflows/hetzner-distributed-recipe-runner.yml packages/tests/hetzner/distributed-recipe-workflow.test.ts
git commit -m "feat: run distributed recipes with external agents"
```

## Iteration 3: GitHub Free Agent Matrix Workflow

Goal: add one manual workflow that starts GitHub-hosted browser-agent shards and a concurrent Hetzner operator using external-agent mode.

### Task 5: Add GitHub Free Distributed Recipe Workflow

**Files:**

- Create: `.github/workflows/github-free-distributed-recipe.yml`
- Create: `scripts/github-actions/plan-github-free-headless-matrix.mjs`
- Create: `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`
- Modify: `docs/environment-variables.md`

**Interfaces:**

- Workflow dispatch inputs:

```yaml
ref: main
manifest_path: apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json
target_agent_count: 50
agents_per_job: 3
max_parallel_jobs: 17
run_id: ""
room_id: hetzner-headless-room
agent_prefix: controller
application_id: rallar-server
workspace_id: default
ready_timeout_seconds: 300
terminal_timeout_seconds: ""
register_before_login: false
browser_log_level: warning
browser_engine: chromium
install_playwright: true
spa_url: https://blackbox.rallar.intactss.com
control_url: wss://control.rallar.intactss.com/control
control_http_url: https://control.rallar.intactss.com
api_base_url: https://api.rallar.intactss.com
```

- Required secrets:

```text
RALLAR_BLACK_BOX_USERNAME
RALLAR_BLACK_BOX_PASSWORD
RALLAR_BLACK_BOX_CONTROL_TOKEN
HETZNER_SSH_PRIVATE_KEY
HETZNER_KNOWN_HOSTS
HETZNER_HOST
HETZNER_USER
```

- Default public endpoint inputs:

```text
https://blackbox.rallar.intactss.com
wss://control.rallar.intactss.com/control
https://api.rallar.intactss.com
https://control.rallar.intactss.com
```

- [ ] **Step 1: Write workflow source tests**

Create tests that assert:

```ts
const workflow = await readFile(path.join(repoRoot, ".github/workflows/github-free-distributed-recipe.yml"), "utf8");
expect(workflow).toContain("name: Run GitHub Free Distributed Recipe");
expect(workflow).toContain("target_agent_count:");
expect(workflow).toContain("agents_per_job:");
expect(workflow).toContain("max_parallel_jobs:");
expect(workflow).toContain("agent_prefix:");
expect(workflow).toContain("default: controller");
expect(workflow).toContain("spa_url:");
expect(workflow).toContain("control_url:");
expect(workflow).toContain("api_base_url:");
expect(workflow).toContain("prepare-hetzner:");
expect(workflow).toContain("operator_phase: prepare");
expect(workflow).toContain("operator_phase: run");
expect(workflow).toContain("needs: [plan, prepare-hetzner]");
expect(workflow).toContain("fromJSON(needs.plan.outputs.matrix)");
expect(workflow).toContain("max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel_jobs) }}");
expect(workflow).toContain("RALLAR_BLACK_BOX_AGENT_START_INDEX");
expect(workflow).toContain("RALLAR_BLACK_BOX_EXIT_MODE: after-target-distributed-run-terminal");
expect(workflow).toContain("npm --workspace rallar-black-box run worker:headless");
expect(workflow).toContain("agent_source: external");
expect(workflow).toContain("uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml");
```

Also assert it rejects Free-plan unsafe parallelism while reserving one hosted job for the operator:

```ts
expect(workflow).toContain("max_parallel_jobs must be between 1 and 19 for GitHub Free");
```

Create tests for `scripts/github-actions/plan-github-free-headless-matrix.mjs` that run the script with Node and assert exact output for the default sizing:

```ts
const result = spawnSync(process.execPath, [
  "scripts/github-actions/plan-github-free-headless-matrix.mjs",
  "--target-agent-count=50",
  "--agents-per-job=3",
  "--max-parallel-jobs=17",
  "--run-id=gh-free-test",
], { cwd: repoRoot, encoding: "utf8" });

expect(result.status).toBe(0);
const output = JSON.parse(result.stdout);
expect(output.runId).toBe("gh-free-test");
expect(output.distributedRunId).toBe("dist-gh-free-test");
expect(output.matrix).toHaveLength(17);
expect(output.matrix[0]).toEqual({ shard_index: 1, agent_start_index: 1, agent_count: 3 });
expect(output.matrix[16]).toEqual({ shard_index: 17, agent_start_index: 49, agent_count: 2 });
```

Also assert the script rejects an agent matrix that would occupy all 20 Free-plan hosted-job slots and leave no concurrent slot for the operator:

```ts
const unsafe = spawnSync(process.execPath, [
  "scripts/github-actions/plan-github-free-headless-matrix.mjs",
  "--target-agent-count=20",
  "--agents-per-job=1",
  "--max-parallel-jobs=20",
  "--run-id=gh-free-unsafe",
], { cwd: repoRoot, encoding: "utf8" });

expect(unsafe.status).not.toBe(0);
expect(unsafe.stderr).toContain("max_parallel_jobs must be between 1 and 19 for GitHub Free");
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
```

Expected before implementation: FAIL because the workflow and matrix script do not exist.

- [ ] **Step 3: Implement matrix planning script**

Create `scripts/github-actions/plan-github-free-headless-matrix.mjs`. It should:

- parse `--target-agent-count`, `--agents-per-job`, `--max-parallel-jobs`, and `--run-id`;
- validate all count inputs as positive integers;
- reject `max_parallel_jobs > 19` with `max_parallel_jobs must be between 1 and 19 for GitHub Free`;
- compute `shard_count = Math.ceil(targetAgentCount / agentsPerJob)`;
- reject `shard_count > maxParallelJobs` with `shard_count must not exceed max_parallel_jobs`;
- emit JSON with `runId`, `distributedRunId`, `maxParallelJobs`, `estimatedSetupMinutes`, `estimatedSixtyMinuteRunMinutes`, and `matrix`.

Use:

```js
const matrix = [];
for (let start = 1, shard = 1; start <= targetAgentCount; shard += 1) {
  const remaining = targetAgentCount - start + 1;
  const agentCount = Math.min(agentsPerJob, remaining);
  matrix.push({ shard_index: shard, agent_start_index: start, agent_count: agentCount });
  start += agentCount;
}
```

- [ ] **Step 4: Implement plan job**

Add a `plan` job that:

- checks out the repo;
- resolves `run_id` to `gh-free-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` when blank;
- resolves `distributed_run_id` to `dist-${run_id}`;
- calls `node scripts/github-actions/plan-github-free-headless-matrix.mjs` for sizing and matrix generation;
- emits the matrix JSON array, `max_parallel_jobs`, `run_id`, `distributed_run_id`, and budget estimates as job outputs;
- writes a GitHub step summary showing default Free-plan concurrency, the estimated 60-minute job-minute cost, and a warning that 17 one-hour shards plus the operator consume roughly 1,080 included minutes plus setup overhead.

For 50 agents and 3 agents per job, the matrix should contain 17 entries:

```json
[
  { "shard_index": 1, "agent_start_index": 1, "agent_count": 3 },
  { "shard_index": 2, "agent_start_index": 4, "agent_count": 3 },
  { "shard_index": 17, "agent_start_index": 49, "agent_count": 2 }
]
```

Use the final shard count of 2 so the workflow starts exactly 50 agents by default.

- [ ] **Step 5: Implement Hetzner prepare job**

Add a `prepare-hetzner` reusable-workflow job that runs before any GitHub agents connect:

```yaml
prepare-hetzner:
  needs: plan
  uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml
  with:
    ref: ${{ inputs.ref }}
    operator_phase: prepare
    rollout_before_run: true
    agent_source: external
    agent_count: ${{ inputs.target_agent_count }}
    run_id: ${{ needs.plan.outputs.run_id }}
    room_id: ${{ inputs.room_id }}
    agent_prefix: ${{ inputs.agent_prefix }}
    manifest_path: ${{ inputs.manifest_path }}
    application_id: ${{ inputs.application_id }}
    workspace_id: ${{ inputs.workspace_id }}
    register_before_login: ${{ inputs.register_before_login }}
    browser_log_level: ${{ inputs.browser_log_level }}
    browser_engine: ${{ inputs.browser_engine }}
    install_playwright: false
    npm_ci: false
    wait_for_agents: false
    ready_timeout_seconds: ${{ inputs.ready_timeout_seconds }}
    terminal_timeout_seconds: ${{ inputs.terminal_timeout_seconds }}
    stop_after_run: false
  secrets: inherit
```

This job is required for the default tree manifest because it carries `metadata.rtcTopologyEnv`. It must not wait for GitHub agents or start the recipe.

- [ ] **Step 6: Implement GitHub agent matrix job**

Add `github-agents` job with:

```yaml
needs: [plan, prepare-hetzner]
strategy:
  fail-fast: false
  max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel_jobs) }}
  matrix:
    shard: ${{ fromJSON(needs.plan.outputs.matrix) }}
timeout-minutes: 75
```

Steps:

- checkout selected `ref`;
- setup Node 20 with npm cache;
- run `npm ci`;
- install selected Playwright browser with `npx playwright install --with-deps ${{ inputs.browser_engine }}`;
- run `npm --workspace rallar-black-box run worker:headless`.

Set env:

```yaml
CI: "1"
RALLAR_BLACK_BOX_SPA_URL: ${{ inputs.spa_url }}
RALLAR_BLACK_BOX_CONTROL_URL: ${{ inputs.control_url }}
RALLAR_CONTROL_HTTP_URL: ${{ inputs.control_http_url }}
RALLAR_API_BASE_URL: ${{ inputs.api_base_url }}
RALLAR_BLACK_BOX_RUN_ID: ${{ needs.plan.outputs.run_id }}
RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID: ${{ needs.plan.outputs.distributed_run_id }}
RALLAR_BLACK_BOX_EXIT_MODE: after-target-distributed-run-terminal
RALLAR_BLACK_BOX_IDLE_EXIT_MS: "4500000"
RALLAR_BLACK_BOX_ROOM_ID: ${{ inputs.room_id }}
RALLAR_BLACK_BOX_AGENT_PREFIX: ${{ inputs.agent_prefix }}
RALLAR_BLACK_BOX_AGENT_COUNT: ${{ matrix.shard.agent_count }}
RALLAR_BLACK_BOX_AGENT_START_INDEX: ${{ matrix.shard.agent_start_index }}
RALLAR_BLACK_BOX_APPLICATION_ID: ${{ inputs.application_id }}
RALLAR_BLACK_BOX_WORKSPACE_ID: ${{ inputs.workspace_id }}
RALLAR_BLACK_BOX_USERNAME: ${{ secrets.RALLAR_BLACK_BOX_USERNAME }}
RALLAR_BLACK_BOX_PASSWORD: ${{ secrets.RALLAR_BLACK_BOX_PASSWORD }}
RALLAR_BLACK_BOX_CONTROL_TOKEN: ${{ secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN }}
RALLAR_BLACK_BOX_REGISTER: ${{ inputs.register_before_login }}
RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: ${{ inputs.browser_log_level }}
RALLAR_BLACK_BOX_HEADLESS_ENTRY: headless
RALLAR_BLACK_BOX_BROWSER_ENGINE: ${{ inputs.browser_engine }}
RALLAR_AGENT_PROVIDER: github-actions
RALLAR_AGENT_REGION: github-hosted
RALLAR_AGENT_DATACENTER: ubuntu-latest
RALLAR_AGENT_POOL_ID: github-free
RALLAR_AGENT_DEPLOYMENT_ID: ${{ github.run_id }}-${{ github.run_attempt }}
RALLAR_AGENT_TAGS: github-actions,free-tier,external-agent
```

- [ ] **Step 7: Implement concurrent operator run job**

Add `operator` job with:

```yaml
needs: [plan, prepare-hetzner]
uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml
with:
  ref: ${{ inputs.ref }}
  operator_phase: run
  rollout_before_run: false
  agent_source: external
  agent_count: ${{ inputs.target_agent_count }}
  run_id: ${{ needs.plan.outputs.run_id }}
  room_id: ${{ inputs.room_id }}
  agent_prefix: ${{ inputs.agent_prefix }}
  manifest_path: ${{ inputs.manifest_path }}
  application_id: ${{ inputs.application_id }}
  workspace_id: ${{ inputs.workspace_id }}
  register_before_login: ${{ inputs.register_before_login }}
  browser_log_level: ${{ inputs.browser_log_level }}
  browser_engine: ${{ inputs.browser_engine }}
  install_playwright: false
  npm_ci: false
  wait_for_agents: true
  ready_timeout_seconds: ${{ inputs.ready_timeout_seconds }}
  terminal_timeout_seconds: ${{ inputs.terminal_timeout_seconds }}
  stop_after_run: false
secrets: inherit
```

Do not add `needs: github-agents`; after `prepare-hetzner` is complete, the operator must run concurrently with `github-agents` and wait through the control server. `operator_phase: run` deliberately skips rollout so it does not restart API/control while agents are connecting.

- [ ] **Step 8: Document workflow usage**

In `docs/environment-variables.md`, add a "GitHub Free distributed recipe workflow" subsection under the Rallar Black Box area. Document the default 50-agent sharding:

```text
target_agent_count=50
agents_per_job=3
max_parallel_jobs=17
agent_prefix=controller
```

Explain that `max_parallel_jobs` must stay at or below 19 for this GitHub Free workflow because the concurrent operator job reserves the 20th hosted-job slot. Also explain that `agent_prefix=controller` is the default because the existing 50-agent role-map manifests target `controller-01` through `controller-50`. Document that changing the prefix requires a matching manifest or a manifest rewrite.

- [ ] **Step 9: Run workflow verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts packages/tests/hetzner/distributed-recipe-workflow.test.ts
git diff --check -- .github/workflows/github-free-distributed-recipe.yml scripts/github-actions/plan-github-free-headless-matrix.mjs docs/environment-variables.md
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add .github/workflows/github-free-distributed-recipe.yml scripts/github-actions/plan-github-free-headless-matrix.mjs packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts docs/environment-variables.md
git commit -m "feat: add github free headless agent workflow"
```

## Iteration 4: Manifest And Barrier Readiness Guardrails

Goal: make accidental non-barrier, wrong-participant-count, or wrong-agent-prefix runs fail before burning GitHub minutes, while warning about barrier settings that are likely too tight for GitHub-hosted agents.

### Task 6: Add Workflow Preflight For Free-Tier Manifests

**Files:**

- Modify: `.github/workflows/github-free-distributed-recipe.yml`
- Modify: `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`

**Interfaces:**

- Consumes `manifest_path`.
- Enforces:
  - `.targetPolicy.expectedParticipantCount == inputs.target_agent_count`
  - `.targetPolicy.mode == "role-map"` manifests only pass when the unique role target count equals `target_agent_count` and every role target plus `roleAssignments[].agentId` uses the selected `${agent_prefix}-NN` range.
  - `.barrier.enabled == true` for 10+ agents
  - `.startMode` is `manual`, `auto-after-ready`, or `scheduled`
  - `.metadata.recommendedTerminalTimeoutSeconds` is present for 60-minute manifests
  - `.metadata.rtcTopologyEnv` is allowed only when the workflow includes the `prepare-hetzner` phase before `github-agents`.
- Warns when `.barrier.timeoutMs < 60000` for GitHub-hosted runs with 10+ agents. The current 50-agent Hetzner smoke manifest uses 15000 ms, which may still work after the operator waits for all agents but is tight for staged command delivery across GitHub-hosted browsers.

- [ ] **Step 1: Write tests**

Add assertions that the workflow reads:

```bash
jq -r '.targetPolicy.expectedParticipantCount // empty'
jq -r '.targetPolicy.mode // empty'
jq -r '[.targetPolicy.roles[]?[]?, .roleAssignments[]?.agentId] | unique | @json'
jq -r '.barrier.enabled // false'
jq -r '.barrier.timeoutMs // empty'
jq -r '.metadata.rtcTopologyEnv // empty'
jq -r '.metadata.recommendedTerminalTimeoutSeconds // empty'
```

and emits clear `::error::` messages for mismatches.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
```

Expected before implementation: FAIL because preflight checks are missing.

- [ ] **Step 3: Implement preflight in the plan job**

Before emitting the matrix, validate:

```bash
manifest_count="$(jq -r '.targetPolicy.expectedParticipantCount // empty' "${MANIFEST_PATH}")"
manifest_target_mode="$(jq -r '.targetPolicy.mode // empty' "${MANIFEST_PATH}")"
manifest_barrier="$(jq -r '.barrier.enabled // false' "${MANIFEST_PATH}")"
manifest_barrier_timeout_ms="$(jq -r '.barrier.timeoutMs // empty' "${MANIFEST_PATH}")"
manifest_start_mode="$(jq -r '.startMode // empty' "${MANIFEST_PATH}")"
manifest_terminal_timeout_seconds="$(jq -r '.metadata.recommendedTerminalTimeoutSeconds // empty' "${MANIFEST_PATH}")"
manifest_rtc_topology_env="$(jq -r '.metadata.rtcTopologyEnv // empty' "${MANIFEST_PATH}")"
if [[ "${manifest_count}" != "${TARGET_AGENT_COUNT}" ]]; then
  echo "::error::Manifest expectedParticipantCount (${manifest_count}) must match target_agent_count (${TARGET_AGENT_COUNT})." >&2
  exit 1
fi
```

For `target_agent_count >= 10`, require `barrier.enabled`:

```bash
if [[ "${TARGET_AGENT_COUNT}" -ge 10 && "${manifest_barrier}" != "true" ]]; then
  echo "::error::GitHub free multi-agent runs require barrier.enabled=true." >&2
  exit 1
fi
```

For role-map manifests, validate the role target IDs against the selected prefix and expected ordinal range:

```bash
role_agent_ids="$(jq -r '[.targetPolicy.roles[]?[]?, .roleAssignments[]?.agentId] | unique | .[]' "${MANIFEST_PATH}")"
role_agent_count="$(printf '%s\n' "${role_agent_ids}" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "${manifest_target_mode}" == "role-map" && "${role_agent_count}" != "${TARGET_AGENT_COUNT}" ]]; then
  echo "::error::Role-map unique agent count (${role_agent_count}) must match target_agent_count (${TARGET_AGENT_COUNT})." >&2
  exit 1
fi
while IFS= read -r agent_id; do
  [[ -z "${agent_id}" ]] && continue
  if [[ ! "${agent_id}" =~ ^${AGENT_PREFIX}-[0-9][0-9]$ ]]; then
    echo "::error::Role-map agent ${agent_id} must match selected agent_prefix ${AGENT_PREFIX}." >&2
    exit 1
  fi
  ordinal="${agent_id##*-}"
  ordinal_number="$((10#${ordinal}))"
  if [[ "${ordinal_number}" -lt 1 || "${ordinal_number}" -gt "${TARGET_AGENT_COUNT}" ]]; then
    echo "::error::Role-map agent ${agent_id} is outside expected range 1..${TARGET_AGENT_COUNT}." >&2
    exit 1
  fi
done <<< "${role_agent_ids}"
```

For 10+ GitHub-hosted agents, warn when the barrier is shorter than the recommended GitHub-hosted timeout:

```bash
manifest_barrier_timeout_ms="${manifest_barrier_timeout_ms:-0}"
if [[ "${TARGET_AGENT_COUNT}" -ge 10 && "${manifest_barrier_timeout_ms}" -lt 60000 ]]; then
  echo "::warning::GitHub free multi-agent runs should prefer barrier.timeoutMs >= 60000 or a GitHub-specific manifest override; current manifest uses ${manifest_barrier_timeout_ms} ms." >&2
fi
```

If `metadata.rtcTopologyEnv` is present, set an output such as `requires_topology_prepare=true` and assert that `prepare-hetzner` is present in the workflow. The default 50-agent tree manifest has `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE`, so this must pass through the prepare job before agents connect.

- [ ] **Step 4: Run verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
git diff --check -- .github/workflows/github-free-distributed-recipe.yml
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/github-free-distributed-recipe.yml packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
git commit -m "feat: guard github free distributed manifests"
```

### Task 7: Add A Short GitHub-Free Smoke Manifest Alias

**Files:**

- Modify: `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`
- Modify: `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
- Modify: `docs/environment-variables.md`

**Interfaces:**

- Reuses existing manifest files:
  - `apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json`
  - `apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json`

- Produces documentation that labels the 30-second tree manifest as the default GitHub Free smoke candidate.
- Produces documentation that calls out the manifest's current `barrier.timeoutMs=15000` and recommends creating a GitHub-specific copy with `barrier.timeoutMs=60000` if staged command delivery misses the barrier in 10+ agent runs.

- [ ] **Step 1: Write tests**

Add assertions that manifest metadata or catalog documentation identifies:

```ts
"github-free-smoke"
"50-agent"
"tree"
```

for the 30-second principal tree manifest.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
```

Expected before implementation: FAIL if the tag/label does not exist yet.

- [ ] **Step 3: Add label/tag without changing recipe semantics**

Add a catalog profile/tag such as `github-free-smoke` to the existing 50-agent 30-second tree manifest descriptor. Do not change command payloads, topology metadata, or expected participant count.

Also document why the default workflow uses `agent_prefix=controller`: the existing manifest role map targets `controller-01` through `controller-50`. Do not change the prefix label unless the manifest role map is changed at the same time.

- [ ] **Step 4: Document run progression**

In `docs/environment-variables.md`, document the recommended progression:

1. 2-agent health.
2. 10-agent 30-second tree.
3. 20-agent 30-second tree.
4. 50-agent 30-second tree using `target_agent_count=50`, `agents_per_job=3`, `max_parallel_jobs=17`.
5. 50-agent 60-minute tree only after the 30-second run is stable.

Add a note after step 3: if any 10+ agent run reaches the staged command but misses the barrier, create a GitHub-specific manifest copy that preserves the same command payloads, topology metadata, role map, and expected participant count, but changes only `distributedRunId`, display/catalog labels, and `barrier.timeoutMs` to `60000`.

- [ ] **Step 5: Run verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/rallar-black-box/src/hetzner-distributed-manifests.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts docs/environment-variables.md
git commit -m "docs: mark github free smoke manifests"
```

## Iteration 5: End-To-End Validation Runbook

Goal: document and verify the first real GitHub Free execution path without requiring local Playwright full-stack changes.

### Task 8: Add Operator Runbook

**Files:**

- Create: `plans/github-actions-rallar-black-box-headless-runbook.md`
- Modify: `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`

**Interfaces:**

- Documents manual dispatch values for:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json
target_agent_count=50
agents_per_job=3
max_parallel_jobs=17
agent_prefix=controller
ready_timeout_seconds=300
terminal_timeout_seconds=900
```

- [ ] **Step 1: Write runbook existence test**

Assert the runbook contains:

```ts
expect(runbook).toContain("GitHub Free");
expect(runbook).toContain("17 shards with agents_per_job=3");
expect(runbook).toContain("Do not set max_parallel_jobs above 19");
expect(runbook).toContain("agent_prefix=controller");
expect(runbook).toContain("prepare-hetzner");
expect(runbook).toContain("agent_source=external");
expect(runbook).toContain("RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal");
expect(runbook).toContain("2,000 included minutes");
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
```

Expected before implementation: FAIL because the runbook does not exist.

- [ ] **Step 3: Write runbook**

Cover:

- prerequisites: deployed Hetzner control server, production secrets, public SPA/API/control URLs;
- first smoke: 2 agents;
- GitHub Free 50-agent smoke: 17 agent jobs x 3 agents with final shard of 2, plus one concurrent operator job;
- why the default prefix is `controller`, and how to verify the manifest role-map agent IDs before changing it;
- the `prepare-hetzner` phase, including why topology env must be applied before GitHub agents connect;
- estimated GitHub Free minute burn for 30-second and 60-minute runs;
- artifact locations;
- common failures: Actions concurrency, monthly minute exhaustion, registration timeout, TURN/ICE issues, manifest count mismatch, role-map prefix mismatch, topology prepare marker failure, short barrier timeout;
- cleanup: no Hetzner headless systemd worker stop is needed in `external` mode.

- [ ] **Step 4: Run documentation verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
rg -n 'T''BD|TO''DO|FIX''ME|fi''ll in|im''plement later' plans/github-actions-rallar-black-box-headless-runbook.md
```

Expected: test PASS; `rg` exits 1 with no matches.

- [ ] **Step 5: Commit**

```bash
git add plans/github-actions-rallar-black-box-headless-runbook.md packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
git commit -m "docs: add github free distributed runbook"
```

### Task 9: Execute Acceptance Runs

**Files:**

- No source files required.
- Generated artifacts remain outside git.

**Interfaces:**

- Uses `.github/workflows/github-free-distributed-recipe.yml`.
- Uses Hetzner control server and artifacts from existing runner.

- [ ] **Step 1: Dispatch 2-agent health smoke**

Dispatch:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json
target_agent_count=2
agents_per_job=1
max_parallel_jobs=2
agent_prefix=controller
ready_timeout_seconds=180
terminal_timeout_seconds=300
```

Expected: workflow passes; operator artifact summary shows terminal `passed`.

- [ ] **Step 2: Dispatch 10-agent tree smoke**

Dispatch a 10-agent barrier tree manifest from the diagnostic matrix:

```text
target_agent_count=10
agents_per_job=2
max_parallel_jobs=5
agent_prefix=controller
ready_timeout_seconds=240
terminal_timeout_seconds=600
```

Expected: workflow passes; artifacts include connected GitHub action agents with provider metadata `github-actions`.

- [ ] **Step 3: Dispatch 50-agent 30-second tree smoke**

Dispatch:

```text
manifest_path=apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json
target_agent_count=50
agents_per_job=3
max_parallel_jobs=17
agent_prefix=controller
ready_timeout_seconds=300
terminal_timeout_seconds=900
```

Expected: workflow either passes or fails with analyzable artifacts. Failure without artifacts is not accepted.

- [ ] **Step 4: Verify identity and targeting in artifacts**

Inspect the exported distributed-run/control-run artifacts and confirm:

```text
50 unique agentId values: controller-01 through controller-50
50 unique sessionId values
50 unique auth.clientId or equivalent browser client identity values
role-map sender target resolved to controller-01
role-map receiver targets resolved to controller-02 through controller-50
all connected agents include provider metadata RALLAR_AGENT_PROVIDER=github-actions
```

Expected: all uniqueness and role-map checks pass. If the same username/password produces duplicate client identity, stop here and add per-agent registration or credential generation before the 60-minute test.

The headless config already accepts per-agent credential env vars named `RALLAR_BLACK_BOX_AGENT_1_USERNAME`, `RALLAR_BLACK_BOX_AGENT_1_PASSWORD`, and so on. Prefer wiring those existing env vars first if unique auth identities are required; add new registration/generation code only if maintaining 50 static credentials becomes the limiter.

- [ ] **Step 5: Record outcomes**

Append a dated note to `playground/FREE_TIER_HEADLESS_BROWSER_DISTRIBUTED_RECIPES.md` with:

- workflow run URL;
- participant count;
- runtime;
- terminal state;
- first failure area when failed;
- whether GitHub Free concurrency or minutes became a limiter.
- whether the 15-second barrier was sufficient or a GitHub-specific 60-second barrier manifest is needed.

- [ ] **Step 6: Commit outcome note only if requested**

Do not commit generated artifacts. Commit only the human-written outcome note when requested:

```bash
git add playground/FREE_TIER_HEADLESS_BROWSER_DISTRIBUTED_RECIPES.md
git commit -m "docs: record github free distributed run outcome"
```

## Cross-Iteration Validation Commands

Run these before opening a PR:

```bash
npx vitest run \
  packages/tests/rallar-black-box/headless-worker-config.test.ts \
  packages/tests/rallar-black-box/headless-worker-script.test.ts \
  packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts \
  packages/tests/hetzner/distributed-recipe-workflow.test.ts

npm --workspace rallar-black-box run typecheck

node scripts/github-actions/plan-github-free-headless-matrix.mjs \
  --target-agent-count=50 \
  --agents-per-job=3 \
  --max-parallel-jobs=17 \
  --run-id=gh-free-validation

git diff --check -- \
  .github/workflows/github-free-distributed-recipe.yml \
  .github/workflows/hetzner-distributed-recipe.yml \
  .github/workflows/hetzner-distributed-recipe-runner.yml \
  apps/rallar-black-box \
  packages/tests/rallar-black-box \
  packages/tests/hetzner \
  scripts/github-actions \
  scripts/hetzner/controller \
  docs/environment-variables.md \
  plans/github-actions-rallar-black-box-headless-runbook.md
```

If `actionlint` is available locally or in CI, also run:

```bash
actionlint .github/workflows/github-free-distributed-recipe.yml .github/workflows/hetzner-distributed-recipe-runner.yml
```

For live acceptance, use the GitHub Actions workflow dispatch sequence in Task 9.

## Open Risks

- GitHub Free private-repo minutes may be exhausted quickly. A 50-agent, 60-minute run at 17 agent jobs plus one operator job is roughly 1,080 job-minutes plus setup overhead.
- GitHub Free limits are external policy, not repo contracts. As of 2026-07-08, the plan assumes 20 concurrent standard GitHub-hosted jobs, 2,000 included minutes per month, and 500 MB artifact storage; re-check GitHub's Actions limits documentation before long or repeated runs.
- GitHub-hosted runners share provider/network characteristics. `50` agents are real browsers but not 50 independent networks.
- A GitHub-hosted job has a 6-hour maximum, so the 60-minute target fits, but setup plus queueing plus barrier wait should be kept comfortably below that.
- If the control server requires strict read tokens, both GitHub agent jobs and the Hetzner operator need compatible token handling.
- If a matrix job fails before registration, the operator should time out with artifacts rather than waiting indefinitely.
- The existing 50-agent tree smoke manifest uses `barrier.timeoutMs=15000`; the plan warns but does not fail on this because the operator waits for all agents before starting. If staged command delivery is flaky, create a GitHub-specific manifest copy with a 60-second barrier before attempting the 60-minute run.
- If shared username/password credentials collapse multiple browser agents into the same authenticated client identity, use the existing `RALLAR_BLACK_BOX_AGENT_N_USERNAME/PASSWORD` support first; if maintaining static credentials becomes impractical, the next iteration must add per-agent registration or credential generation before interpreting RTC delivery results.

## Implementation Progress

### Iteration 1 - 2026-07-08T11:10:21Z

- Completed steps: Task 1 steps 1-5; Task 2 steps 1-4.
- Files changed: `apps/rallar-black-box/src/headless-worker-config.ts`, `apps/rallar-black-box/scripts/headless-worker.ts`, `packages/tests/rallar-black-box/headless-worker-config.test.ts`, `packages/tests/rallar-black-box/headless-worker-script.test.ts`, `docs/environment-variables.md`, `plans/github-actions-rallar-black-box-headless-implementation-plan.md`.
- Commands run:
  - `npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts` before red tests: PASS, 20 tests.
  - `npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts` after adding planned tests: FAIL as expected because exit config fields and terminal polling helpers were missing.
  - `npx vitest run packages/tests/rallar-black-box/headless-worker-config.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts` after implementation: PASS, 24 tests.
  - `npm --workspace rallar-black-box run typecheck`: PASS.
- Blockers: none for Iteration 1 local implementation.
- Notes: The worker source test checks the dynamic log template `Distributed run ${runId} is not created yet` rather than forcing production code to contain the sample id `dist-run-1`.
- Follow-up validation still required: none for Iteration 1 local implementation.
- Implementation detail: Task 1 and Task 2 changes were grouped into one Iteration 1 commit (`3e52bb1`, `feat: add headless worker exit config`) instead of split into two commits.
