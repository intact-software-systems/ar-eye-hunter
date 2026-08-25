import { assert, assertEquals } from "@std/assert";

import {
  registerAgent,
  waitForPathMissing,
  waitForSocketClose,
  waitForSocketOpen,
} from "./support/control-api-test-agent.ts";
import {
  ADMIN_TOKEN,
  adminHeaders,
  canBindLoopback,
  getJson,
  startControlServer,
} from "./support/control-api-test-server.ts";

Deno.test("retention preview is authorized, non-destructive, and guarded before cleanup", async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({
    prefix: "rallar-retention-api-",
  });
  const snapshotPath = `${storageDir}/control-snapshot.json`;
  const run = (runId: string, updatedAtEpochMs: number) => ({
    runId,
    createdAtEpochMs: updatedAtEpochMs,
    updatedAtEpochMs,
    agents: [],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: [],
  });
  await Deno.writeTextFile(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      savedAtEpochMs: 3_000,
      snapshot: {
        runs: [run("retention-old", 1_000), run("retention-new", 2_000)],
        distributedRuns: [{
          distributedRunId: "retention-dist-old",
          controlRunId: "retention-old",
          manifest: {
            distributedRunId: "retention-dist-old",
            controlRunId: "retention-old",
            group: {
              applicationId: "rallar-server",
              workspaceId: "default",
              groupId: "retention-group",
            },
            recipes: [],
            targetPolicy: { mode: "selected-agents", agentIds: [] },
          },
          state: "failed",
          createdAtEpochMs: 1_000,
          updatedAtEpochMs: 1_000,
          targetAgentIds: [],
          commandLinks: [],
          rollup: {
            state: "failed",
            ok: false,
            summary: {
              participants: 0,
              requiredParticipants: 0,
              readyParticipants: 0,
              passedParticipants: 0,
              failedParticipants: 0,
              recipes: 0,
              requiredRecipes: 0,
              passedRecipes: 0,
              failedRecipes: 0,
              blockingFailures: 0,
            },
            failures: [],
          },
        }],
        fleetReports: [{
          fleetReportSchemaVersion: 1,
          distributedRunId: "retention-dist-old",
          controlRunId: "retention-old",
          generatedAtEpochMs: 2_000,
          state: "failed",
          ok: false,
          group: {
            applicationId: "rallar-server",
            workspaceId: "default",
            groupId: "retention-group",
          },
          recipeIds: [],
          summary: {
            agents: 0,
            regions: 0,
            passed: 0,
            failed: 1,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 0,
            failureGroups: 1,
          },
          timing: { run: { count: 0 }, commands: { count: 0 } },
          agents: [],
          regions: [],
          failureSignatures: [],
          artifactRefs: {
            distributedRun: "/distributed-runs/retention-dist-old",
            controlRun: "/runs/retention-old",
            fleetReport: "/fleet/reports/retention-dist-old",
          },
        }],
      },
    }),
  );
  const artifactDir = `${storageDir}/runs/retention-old`;
  const artifactPath = `${artifactDir}/sentinel.jsonl`;
  await Deno.mkdir(artifactDir, { recursive: true });
  await Deno.writeTextFile(artifactPath, "manual-cleanup-must-preserve-this\n");
  const beforePreview = await Deno.readTextFile(snapshotPath);
  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: "8",
    RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: "1",
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let unregisteredSocket: WebSocket | undefined;
  try {
    unregisteredSocket = new WebSocket(
      `${server.baseUrl.replace(/^http/, "ws")}/control`,
    );
    await waitForSocketOpen(unregisteredSocket);
    const unauthorizedBody = { error: "Admin token is required or invalid." };
    for (
      const query of [
        "?dryRun=true",
        "?dryRun=false",
        "?dryRun=true&dryRun=true",
        "?planToken=v1.abc.def",
        "?planToken=v1.abc.def&planToken=v1.abc.def",
        "?dryRun=true&planToken=v1.abc.def",
        `?planToken=${"a".repeat(513)}`,
        "?planToken=v1.abc.def&token=v1.abc.def",
      ]
    ) {
      const unauthorized = await fetch(
        `${server.baseUrl}/retention/cleanup${query}`,
        {
          method: "POST",
        },
      );
      assertEquals(unauthorized.status, 401);
      assertEquals(await unauthorized.json(), unauthorizedBody);
    }

    for (
      const query of [
        "?dryRun=false",
        "?dryRun=",
        "?dryRun=true&dryRun=true",
        "?planToken=",
        "?planToken=v1.abc.def&planToken=v1.abc.def",
        "?dryRun=true&planToken=v1.abc.def",
        `?planToken=${"a".repeat(513)}`,
      ]
    ) {
      const invalid = await fetch(
        `${server.baseUrl}/retention/cleanup${query}`,
        {
          method: "POST",
          headers: adminHeaders(),
        },
      );
      assertEquals(invalid.status, 400);
    }

    const previewResponse = await fetch(
      `${server.baseUrl}/retention/cleanup?dryRun=true`,
      {
        method: "POST",
        headers: adminHeaders(),
        body:
          "{ malformed and intentionally larger than the request body limit",
      },
    );
    assertEquals(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      dryRun?: boolean;
      deletedRunIds?: readonly string[];
      retainedRuns?: number;
      projectedRetainedRuns?: number;
      maxRuns?: number;
      wouldDeleteRuns?: readonly {
        runId: string;
        createdAtEpochMs: number;
        updatedAtEpochMs: number;
        connectedAgentCount: number;
        issuedRunTokenCount: number;
        distributedRuns: readonly object[];
        fleetReportIds: readonly string[];
      }[];
      wouldDeleteRunIds?: readonly string[];
      wouldDeleteDistributedRunIds?: readonly string[];
      wouldDeleteFleetReportIds?: readonly string[];
      preserves?: {
        connectedAgentSockets?: boolean;
        storedArtifactFiles?: boolean;
      };
      planToken?: string;
    };
    assertEquals(preview.dryRun, true);
    assertEquals(preview.deletedRunIds, []);
    assertEquals(preview.retainedRuns, 2);
    assertEquals(preview.projectedRetainedRuns, 1);
    assertEquals(preview.maxRuns, 1);
    assertEquals(preview.wouldDeleteRuns, [{
      runId: "retention-old",
      createdAtEpochMs: 1_000,
      updatedAtEpochMs: 1_000,
      connectedAgentCount: 0,
      issuedRunTokenCount: 0,
      distributedRuns: [{
        distributedRunId: "retention-dist-old",
        state: "failed",
      }],
      fleetReportIds: ["retention-dist-old"],
    }]);
    assertEquals(preview.wouldDeleteRunIds, ["retention-old"]);
    assertEquals(preview.wouldDeleteDistributedRunIds, ["retention-dist-old"]);
    assertEquals(preview.wouldDeleteFleetReportIds, ["retention-dist-old"]);
    assertEquals(preview.preserves, {
      connectedAgentSockets: true,
      storedArtifactFiles: true,
    });
    assert(
      typeof preview.planToken === "string" && preview.planToken.length > 0,
    );
    assert(!JSON.stringify(preview).includes("revision:"));
    assert(!JSON.stringify(preview).includes("canonicalConsequence"));
    assertEquals(await Deno.readTextFile(snapshotPath), beforePreview);
    assertEquals(
      await Deno.readTextFile(artifactPath),
      "manual-cleanup-must-preserve-this\n",
    );
    assertEquals(unregisteredSocket.readyState, WebSocket.OPEN);
    assertEquals(
      (await getJson<{ runs: readonly object[] }>(server.baseUrl, "/runs")).runs
        .length,
      2,
    );

    const tamperedToken = `${preview.planToken.slice(0, -1)}${
      preview.planToken.endsWith("A") ? "B" : "A"
    }`;
    const staleBody = {
      error:
        "Retention preview is stale, expired, or belongs to another server process.",
    };
    const tampered = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${
        encodeURIComponent(tamperedToken)
      }`,
      { method: "POST", headers: adminHeaders() },
    );
    assertEquals(tampered.status, 409);
    assertEquals(await tampered.json(), staleBody);
    assertEquals(
      (await getJson<{ runs: readonly object[] }>(server.baseUrl, "/runs")).runs
        .length,
      2,
    );

    const unauthorizedIssuedToken = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${
        encodeURIComponent(preview.planToken)
      }`,
      { method: "POST" },
    );
    assertEquals(unauthorizedIssuedToken.status, 401);
    assertEquals(await unauthorizedIssuedToken.json(), unauthorizedBody);

    const otherStorageDir = await Deno.makeTempDir({
      prefix: "rallar-retention-other-",
    });
    await Deno.writeTextFile(
      `${otherStorageDir}/control-snapshot.json`,
      beforePreview,
    );
    const otherServer = await startControlServer({
      RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
      RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: "1",
      RALLAR_BLACK_BOX_STORAGE_DIR: otherStorageDir,
    });
    try {
      const wrongProcess = await fetch(
        `${otherServer.baseUrl}/retention/cleanup?planToken=${
          encodeURIComponent(preview.planToken)
        }`,
        { method: "POST", headers: adminHeaders() },
      );
      assertEquals(wrongProcess.status, 409);
      assertEquals(await wrongProcess.json(), staleBody);
      assertEquals(
        (await getJson<{ runs: readonly object[] }>(
          otherServer.baseUrl,
          "/runs",
        )).runs.length,
        2,
      );
    } finally {
      await otherServer.stop();
      await Deno.remove(otherStorageDir, { recursive: true });
    }

    const confirmResponse = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${
        encodeURIComponent(preview.planToken)
      }`,
      {
        method: "POST",
        headers: adminHeaders(),
        body:
          "{ malformed and intentionally larger than the request body limit",
      },
    );
    assertEquals(confirmResponse.status, 200);
    assertEquals(await confirmResponse.json(), {
      deletedRunIds: ["retention-old"],
      retainedRuns: 1,
      maxRuns: 1,
    });
    assertEquals(
      await Deno.readTextFile(artifactPath),
      "manual-cleanup-must-preserve-this\n",
    );
    assertEquals(unregisteredSocket.readyState, WebSocket.OPEN);
    assertEquals(
      (await getJson<{ distributedRuns: readonly object[] }>(
        server.baseUrl,
        "/distributed-runs",
      )).distributedRuns.length,
      0,
    );
    assertEquals(
      (await getJson<{ reports: readonly object[] }>(
        server.baseUrl,
        "/fleet/reports",
      )).reports
        .length,
      0,
    );

    const reused = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${
        encodeURIComponent(preview.planToken)
      }`,
      { method: "POST", headers: adminHeaders() },
    );
    assertEquals(reused.status, 409);
    assertEquals(await reused.json(), staleBody);

    const immediateCleanup = await fetch(
      `${server.baseUrl}/retention/cleanup?unknown=value`,
      {
        method: "POST",
        headers: adminHeaders(),
        body:
          "{ malformed and intentionally larger than the request body limit",
      },
    );
    assertEquals(immediateCleanup.status, 200);
    assertEquals(await immediateCleanup.json(), {
      deletedRunIds: [],
      retainedRuns: 1,
      maxRuns: 1,
    });
    assertEquals(
      await Deno.readTextFile(artifactPath),
      "manual-cleanup-must-preserve-this\n",
    );
  } finally {
    unregisteredSocket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test("automatic retention closes deleted-run sockets and artifact files", async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({
    prefix: "rallar-auto-retention-",
  });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: "1",
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let oldSocket: WebSocket | undefined;
  let newSocket: WebSocket | undefined;
  try {
    oldSocket = await registerAgent(server.baseUrl, "auto-old", "agent-old");
    const oldArtifactDir = `${storageDir}/runs/auto-old`;
    await Deno.mkdir(oldArtifactDir, { recursive: true });
    await Deno.writeTextFile(
      `${oldArtifactDir}/sentinel.jsonl`,
      "remove-on-auto-prune\n",
    );

    const oldSocketClose = waitForSocketClose(oldSocket);
    newSocket = await registerAgent(server.baseUrl, "auto-new", "agent-new");
    const close = await oldSocketClose;

    assertEquals(close.code, 1000);
    assertEquals(close.reason, "run deleted");
    await waitForPathMissing(oldArtifactDir);
    const runs = await getJson<{ runs: readonly { runId: string }[] }>(
      server.baseUrl,
      "/runs",
    );
    assertEquals(runs.runs.map((entry) => entry.runId), ["auto-new"]);
    assertEquals(newSocket.readyState, WebSocket.OPEN);
  } finally {
    oldSocket?.close();
    newSocket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});
