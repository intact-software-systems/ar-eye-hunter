import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("GitHub Free distributed recipe workflow", () => {
  it("defines the GitHub Free headless agent pool workflow", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/github-free-distributed-recipe.yml"),
      "utf8",
    );

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
    expect(workflow).toContain(
      "max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel_jobs) }}",
    );
    expect(workflow).toContain("RALLAR_BLACK_BOX_AGENT_START_INDEX");
    expect(workflow).toContain(
      "RALLAR_BLACK_BOX_EXIT_MODE: after-target-distributed-run-terminal",
    );
    expect(workflow).toContain(
      "npm --workspace rallar-black-box run worker:headless",
    );
    expect(workflow).toContain("agent_source: external");
    expect(workflow).toContain(
      "uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml",
    );
    expect(workflow).toContain(
      "max_parallel_jobs must be between 1 and 19 for GitHub Free",
    );
  });

  it("plans deterministic GitHub Free worker shards", () => {
    const result = spawnSync(process.execPath, [
      "scripts/github-actions/plan-github-free-headless-matrix.mjs",
      "--target-agent-count=50",
      "--agents-per-job=3",
      "--max-parallel-jobs=17",
      "--run-id=gh-free-test",
    ], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      runId: string;
      distributedRunId: string;
      matrix: unknown[];
    };
    expect(output.runId).toBe("gh-free-test");
    expect(output.distributedRunId).toBe("dist-gh-free-test");
    expect(output.matrix).toHaveLength(17);
    expect(output.matrix[0]).toEqual({
      shard_index: 1,
      agent_start_index: 1,
      agent_count: 3,
    });
    expect(output.matrix[16]).toEqual({
      shard_index: 17,
      agent_start_index: 49,
      agent_count: 2,
    });
  });

  it("rejects an agent matrix that leaves no GitHub Free slot for the operator", () => {
    const unsafe = spawnSync(process.execPath, [
      "scripts/github-actions/plan-github-free-headless-matrix.mjs",
      "--target-agent-count=20",
      "--agents-per-job=1",
      "--max-parallel-jobs=20",
      "--run-id=gh-free-unsafe",
    ], { cwd: repoRoot, encoding: "utf8" });

    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stderr).toContain(
      "max_parallel_jobs must be between 1 and 19 for GitHub Free",
    );
  });

  it("preflights free-tier manifests before planning the matrix", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/github-free-distributed-recipe.yml"),
      "utf8",
    );

    expect(workflow).toContain("jq -r '.targetPolicy.expectedParticipantCount // empty'");
    expect(workflow).toContain("jq -r '.targetPolicy.mode // empty'");
    expect(workflow).toContain("jq -r '[.targetPolicy.roles[]?[]?, .roleAssignments[]?.agentId] | unique | @json'");
    expect(workflow).toContain("jq -r '.barrier.enabled // false'");
    expect(workflow).toContain("jq -r '.barrier.timeoutMs // empty'");
    expect(workflow).toContain("jq -r '.metadata.rtcTopologyEnv // empty'");
    expect(workflow).toContain("jq -r '.metadata.recommendedTerminalTimeoutSeconds // empty'");
    expect(workflow).toContain(
      "::error::Manifest expectedParticipantCount",
    );
    expect(workflow).toContain(
      "::error::GitHub free multi-agent runs require barrier.enabled=true.",
    );
    expect(workflow).toContain(
      "::error::Role-map unique agent count",
    );
    expect(workflow).toContain(
      "::error::Role-map agent ${agent_id} must match selected agent_prefix",
    );
    expect(workflow).toContain(
      "::error::Manifest startMode must be manual, auto-after-ready, or scheduled.",
    );
    expect(workflow).toContain("requires_topology_prepare=true");
  });
});
