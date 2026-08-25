import { assert, assertEquals } from "@std/assert";

import {
  registerAgent,
  waitForPersistedSnapshot,
} from "./support/control-api-test-agent.ts";
import { distributedManifest } from "./support/control-api-test-fixtures.ts";
import {
  ADMIN_TOKEN,
  adminHeaders,
  bearerJsonHeaders,
  canBindLoopback,
  getJson,
  OPERATOR_TOKEN_SECRET,
  operatorToken,
  startControlServer,
} from "./support/control-api-test-server.ts";

interface HealthResponse {
  readonly ok?: boolean;
}

Deno.test("read-token mode protects run, fleet, and distributed GET routes", async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: "1",
  });
  try {
    const health = await getJson<HealthResponse>(server.baseUrl, "/health");
    assertEquals(health.ok, true);

    const openApi = await fetch(`${server.baseUrl}/api/openapi.json`);
    assertEquals(openApi.status, 200);

    for (const path of ["/runs", "/distributed-runs", "/fleet/reports"]) {
      const unauthorized = await fetch(`${server.baseUrl}${path}`);
      assertEquals(unauthorized.status, 401);

      const authorized = await fetch(`${server.baseUrl}${path}`, {
        headers: adminHeaders(),
      });
      assertEquals(authorized.status, 200);
    }
  } finally {
    await server.stop();
  }
});

Deno.test("read-token mode fails closed without an auth backend", async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: "1",
  });
  try {
    const health = await getJson<HealthResponse>(server.baseUrl, "/health");
    assertEquals(health.ok, true);

    for (const path of ["/runs", "/distributed-runs", "/fleet/reports"]) {
      const unauthorized = await fetch(`${server.baseUrl}${path}`);
      assertEquals(unauthorized.status, 401);
    }
  } finally {
    await server.stop();
  }
});

Deno.test("distributed and fleet APIs validate auth, artifacts, filters, and persisted restore", async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: "rallar-control-api-" });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: OPERATOR_TOKEN_SECRET,
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let agentSocket: WebSocket | undefined;
  try {
    agentSocket = await registerAgent(
      server.baseUrl,
      "api-control-run",
      "agent-a",
    );

    const unauthorizedCreate = await fetch(
      `${server.baseUrl}/distributed-runs`,
      {
        method: "POST",
        body: JSON.stringify({ manifest: distributedManifest() }),
      },
    );
    assertEquals(unauthorizedCreate.status, 401);

    const signedOperatorToken = await operatorToken();
    const previewResponse = await fetch(
      `${server.baseUrl}/distributed-runs/resolve-targets`,
      {
        method: "POST",
        headers: bearerJsonHeaders(signedOperatorToken),
        body: JSON.stringify({
          manifest: {
            ...distributedManifest(),
            targetPolicy: {
              mode: "all-online-group-members",
              expectedParticipantCount: 1,
            },
            roleAssignmentPolicy: {
              mode: "ordered-targets",
              pattern: "one-sender-many-receivers",
              orderBy: "agent-id",
            },
          },
        }),
      },
    );
    assertEquals(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      targetAgentIds: readonly string[];
      summary: {
        selected: number;
        expectedParticipantCount?: number;
        roleCounts: Record<string, number>;
      };
    };
    assertEquals(preview.targetAgentIds, ["agent-a"]);
    assertEquals(preview.summary.selected, 1);
    assertEquals(preview.summary.expectedParticipantCount, 1);
    assertEquals(preview.summary.roleCounts, { sender: 1 });

    const createdResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
      method: "POST",
      headers: bearerJsonHeaders(signedOperatorToken),
      body: JSON.stringify({ manifest: distributedManifest() }),
    });
    assertEquals(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      distributedRunId: string;
      targetAgentIds: readonly string[];
    };
    assertEquals(created.distributedRunId, "api-dist-1");
    assertEquals(created.targetAgentIds, ["agent-a"]);

    const stagedResponse = await fetch(
      `${server.baseUrl}/distributed-runs/api-dist-1/stage`,
      {
        method: "POST",
        headers: bearerJsonHeaders(signedOperatorToken),
      },
    );
    assertEquals(stagedResponse.status, 202);
    const staged = await stagedResponse.json() as {
      state: string;
      commandLinks: readonly {
        phase: string;
        agentId: string;
        commandId: string;
        recipeId?: string;
      }[];
    };
    assertEquals(staged.state, "waiting-for-ack");
    assertEquals(staged.commandLinks.length, 1);
    assertEquals(staged.commandLinks[0].phase, "stage");
    assertEquals(staged.commandLinks[0].agentId, "agent-a");
    assertEquals(staged.commandLinks[0].recipeId, "api-health");

    const startedResponse = await fetch(
      `${server.baseUrl}/distributed-runs/api-dist-1/start`,
      {
        method: "POST",
        headers: bearerJsonHeaders(signedOperatorToken),
      },
    );
    assertEquals(startedResponse.status, 202);
    const started = await startedResponse.json() as { state: string };
    assertEquals(started.state, "waiting-for-ack");

    const distributed = await getJson<{
      state: string;
      manifest: { distributedRunId: string };
    }>(server.baseUrl, "/distributed-runs/api-dist-1");
    assertEquals(distributed.manifest.distributedRunId, "api-dist-1");

    const distributedArtifact = await getJson<{
      artifactSchemaVersion: number;
      files: Record<string, string>;
    }>(server.baseUrl, "/distributed-runs/api-dist-1/artifacts");
    assertEquals(distributedArtifact.artifactSchemaVersion, 2);
    assert(distributedArtifact.files["manifest.json"].includes("api-dist-1"));
    assert("metadata.json" in distributedArtifact.files);

    const fleet = await getJson<{
      reports: readonly object[];
      aggregate: { runCount: number };
    }>(server.baseUrl, "/fleet/reports?region=eu-north");
    assertEquals(fleet.reports.length, 0);
    assertEquals(fleet.aggregate.runCount, 0);

    const unauthorizedRebuild = await fetch(
      `${server.baseUrl}/fleet/reports/rebuild`,
      {
        method: "POST",
      },
    );
    assertEquals(unauthorizedRebuild.status, 401);
    const rebuildResponse = await fetch(
      `${server.baseUrl}/fleet/reports/rebuild`,
      {
        method: "POST",
        headers: adminHeaders(),
      },
    );
    assertEquals(rebuildResponse.status, 200);

    await waitForPersistedSnapshot(storageDir, "api-dist-1");
    agentSocket.close();
    agentSocket = undefined;
    await waitForPersistedSnapshot(storageDir, '"state": "failed"');
  } finally {
    await server.stop();
    agentSocket?.close();
  }

  const restored = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  try {
    const restoredRun = await getJson<{
      distributedRunId: string;
      state: string;
    }>(restored.baseUrl, "/distributed-runs/api-dist-1");
    assertEquals(restoredRun.distributedRunId, "api-dist-1");
    assertEquals(restoredRun.state, "failed");
  } finally {
    await restored.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});
