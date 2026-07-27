import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';

const CONTROL_ROOT = new URL('..', import.meta.url).pathname;
const ADMIN_TOKEN = 'black-box-admin-token';
const OPERATOR_TOKEN_SECRET = 'black-box-operator-token-secret';

type StartedControlServer = Readonly<{
  baseUrl: string;
  storageDir: string;
  stop(): Promise<void>;
}>;

type HealthResponse = Readonly<{
  ok?: boolean;
  app?: string;
}>;

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

Deno.test('control server REST API enforces tokens, queues commands, and exports run artifacts', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1',
  });
  try {
    const health = await getJson<HealthResponse>(server.baseUrl, '/health');
    assertEquals(health.ok, true);
    assertEquals(health.app, 'rallar-black-box-control-server');

    const unauthorizedCommand = await fetch(
      `${server.baseUrl}/runs/http-run/agents/agent-a/commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: 'health-unauthorized',
          command: { kind: 'health', commandId: 'health-unauthorized' },
        }),
      },
    );
    assertEquals(unauthorizedCommand.status, 401);

    const tokenResponse = await fetch(`${server.baseUrl}/runs/http-run/agents/agent-a/tokens`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ ttlMs: 60_000 }),
    });
    assertEquals(tokenResponse.status, 201);
    const token = await tokenResponse.json() as { token: string };
    assert(token.token.length > 12);

    const commandResponse = await fetch(`${server.baseUrl}/runs/http-run/agents/agent-a/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rallar-run-token': token.token,
      },
      body: JSON.stringify({
        commandId: 'health-1',
        command: { kind: 'health', commandId: 'health-1' },
      }),
    });
    assertEquals(commandResponse.status, 202);
    const commandAccepted = await commandResponse.json() as {
      accepted?: boolean;
      command?: { commandId?: string };
    };
    assertEquals(commandAccepted.accepted, true);
    assertEquals(commandAccepted.command?.commandId, 'health-1');

    const bulkResponse = await fetch(`${server.baseUrl}/runs/http-run/commands`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        agentIds: ['agent-a', 'agent-b'],
        commandIdPrefix: 'bulk-health',
        command: { kind: 'health' },
      }),
    });
    assertEquals(bulkResponse.status, 202);
    const bulkAccepted = await bulkResponse.json() as {
      commands?: readonly { commandId: string; agentId?: string }[];
    };
    assertEquals(bulkAccepted.commands?.map((command) => command.commandId), [
      'bulk-health-agent-a',
      'bulk-health-agent-b',
    ]);

    const runResponse = await fetch(
      `${server.baseUrl}/runs/http-run?limitCommands=2`,
    );
    assertEquals(runResponse.status, 200);
    const runText = await runResponse.text();
    assert(
      !runText.includes('\n'),
      'High-frequency control JSON responses should use compact serialization.',
    );
    const run = JSON.parse(runText) as {
      commands: readonly { envelope: { commandId: string } }[];
    };
    assertEquals(run.commands.map((command) => command.envelope.commandId), [
      'bulk-health-agent-a',
      'bulk-health-agent-b',
    ]);

    const artifact = await getJson(server.baseUrl, '/runs/http-run/artifacts') as {
      artifactSchemaVersion: number;
      files: Record<string, string>;
    };
    assertEquals(artifact.artifactSchemaVersion, 1);
    const artifactReport = JSON.parse(artifact.files['report.json']) as {
      outputs?: { commandCount?: number };
    };
    assertEquals(artifactReport.outputs?.commandCount, 3);

    const reportFile = await fetch(`${server.baseUrl}/runs/http-run/artifacts/report.json`);
    assertEquals(reportFile.status, 200);
    assert(reportFile.headers.get('content-type')?.includes('application/json'));

    const missingFile = await fetch(`${server.baseUrl}/runs/http-run/artifacts/unknown.json`);
    assertEquals(missingFile.status, 404);
  } finally {
    await server.stop();
  }
});

Deno.test('control server rejects oversized HTTP and WebSocket agent payloads', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: '256',
  });
  try {
    const oversizedReport = await fetch(`${server.baseUrl}/runs/run-big/agents/agent-a/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'report',
        protocolVersion: 1,
        runId: 'run-big',
        agentId: 'agent-a',
        atEpochMs: Date.now(),
        eventId: 'oversized-report',
        payload: {
          kind: 'report',
          payload: {
            reportId: 'oversized-report',
            results: [{ value: 'x'.repeat(512) }],
          },
        },
      }),
    });
    assertEquals(oversizedReport.status, 413);

    const socket = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/control`);
    await waitForSocketOpen(socket);
    const closed = waitForSocketClose(socket);
    socket.send(JSON.stringify({
      kind: 'event',
      protocolVersion: 1,
      runId: 'run-big',
      agentId: 'agent-a',
      atEpochMs: Date.now(),
      eventId: 'oversized-ws',
      payload: {
        value: 'x'.repeat(512),
      },
    }));
    assertEquals((await closed).code, 1009);
  } finally {
    await server.stop();
  }
});

Deno.test('control server stores full artifact JSONL on disk after runtime trimming', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-artifacts-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0',
  });
  let socket: WebSocket | undefined;
  try {
    socket = await registerAgent(server.baseUrl, 'trim-run', 'agent-a');
    socket.send(JSON.stringify({
      kind: 'result',
      protocolVersion: 1,
      runId: 'trim-run',
      agentId: 'agent-a',
      commandId: 'heavy-result',
      ok: false,
      error: {
        code: 'HEAVY_FAILURE',
        message: 'The full result remains in artifact JSONL.',
        details: {
          value: 'x'.repeat(1024),
        },
      },
    }));
    socket.send(JSON.stringify({
      kind: 'event',
      protocolVersion: 1,
      runId: 'trim-run',
      agentId: 'agent-a',
      atEpochMs: Date.now(),
      eventId: 'heavy-event',
      payload: {
        topic: 'rallar.bb.heavy',
        value: 'y'.repeat(1024),
      },
    }));
    socket.send(JSON.stringify({
      kind: 'report',
      protocolVersion: 1,
      runId: 'trim-run',
      agentId: 'agent-a',
      atEpochMs: Date.now(),
      eventId: 'heavy-report',
      payload: {
        kind: 'report',
        topic: 'rallar.bb.report.final',
        payload: {
          reportId: 'heavy-report',
          summary: { reason: 'legacy-agent' },
          events: [{ eventId: 'legacy-report-heavy', value: 'z'.repeat(1024) }],
        },
      },
    }));

    await waitForJsonl(server.baseUrl, '/runs/trim-run/results.jsonl', 'HEAVY_FAILURE');
    await waitForJsonl(server.baseUrl, '/runs/trim-run/events.jsonl', 'heavy-event');
    await waitForJsonl(server.baseUrl, '/runs/trim-run/events.jsonl', 'legacy-report-heavy');
    const artifactResults = await fetch(
      `${server.baseUrl}/runs/trim-run/artifacts/results.jsonl`,
    );
    assertEquals(artifactResults.status, 200);
    assert(
      (await artifactResults.text()).includes('HEAVY_FAILURE'),
      'per-file results artifact should stream the stored JSONL evidence',
    );

    const snapshot = await getJson(server.baseUrl, '/runs/trim-run') as {
      results?: readonly unknown[];
      events?: readonly unknown[];
      reports?: readonly unknown[];
    };
    assertEquals(snapshot.results?.length, 0);
    assertEquals(snapshot.events?.length, 0);
    assertEquals(snapshot.reports?.length, 1);
    assertEquals(JSON.stringify(snapshot.reports).includes('legacy-report-heavy'), false);
  } finally {
    socket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('control server stores command metadata in disk-backed JSONL rows', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-artifact-metadata-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS: '0',
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0',
  });
  let socket: WebSocket | undefined;
  try {
    const commandResponse = await fetch(
      `${server.baseUrl}/runs/metadata-run/agents/agent-a/commands`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'rtc-send-1',
          command: {
            kind: 'rtc.send',
            commandId: 'rtc-send-1',
            connection: 'rtc-connection-1',
            transport: 'messages.rtc',
            send: { text: 'hello' },
          },
        }),
      },
    );
    assertEquals(commandResponse.status, 202);

    socket = await registerAgent(server.baseUrl, 'metadata-run', 'agent-a');
    socket.send(JSON.stringify({
      kind: 'result',
      protocolVersion: 1,
      runId: 'metadata-run',
      agentId: 'agent-a',
      commandId: 'rtc-send-1',
      ok: true,
      result: {
        commandId: 'rtc-send-1',
        kind: 'rtc.send',
        status: 'ok',
        ok: true,
        value: { delivered: true },
      },
    }));

    const resultsText = await waitForJsonl(
      server.baseUrl,
      '/runs/metadata-run/results.jsonl',
      'rtc-send-1',
    );
    const resultRow = JSON.parse(resultsText.trim().split(/\r?\n/g)[0]) as {
      action?: string;
      transport?: string;
      connection?: string;
    };
    assertEquals(resultRow.action, 'rtc.send');
    assertEquals(resultRow.transport, 'messages.rtc');
    assertEquals(resultRow.connection, 'rtc-connection-1');

    const eventsText = await waitForJsonl(
      server.baseUrl,
      '/runs/metadata-run/events.jsonl',
      'rtc-send-1',
    );
    const stepResult = eventsText
      .trim()
      .split(/\r?\n/g)
      .map((line) => JSON.parse(line) as { kind?: string; action?: string; transport?: string })
      .find((row) => row.kind === 'step-result');
    assert(stepResult);
    assertEquals(stepResult.action, 'rtc.send');
    assertEquals(stepResult.transport, 'messages.rtc');
  } finally {
    socket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('control server waits for queued artifact JSONL writes before responding', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-artifact-flush-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
    RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: '2000000',
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS: '0',
  });
  try {
    const seedMarker = 'artifact-flush-seed';
    const seedResponse = await fetch(`${server.baseUrl}/runs/flush-run/agents/agent-a/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reportEnvelope('flush-run', 'agent-a', 'seed-report', seedMarker)),
    });
    assertEquals(seedResponse.status, 202);
    await waitForJsonl(server.baseUrl, '/runs/flush-run/events.jsonl', seedMarker);

    const backlogResponses = await Promise.all(
      Array.from(
        { length: 6 },
        (_, index) =>
          fetch(`${server.baseUrl}/runs/flush-run/agents/agent-a/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              reportEnvelope(
                'flush-run',
                'agent-a',
                `backlog-report-${index}`,
                `artifact-flush-backlog-${index}`,
                'x'.repeat(1_500_000),
              ),
            ),
          }),
      ),
    );
    for (const response of backlogResponses) {
      assertEquals(response.status, 202);
    }

    const targetMarker = 'artifact-flush-target';
    const targetResponse = await fetch(`${server.baseUrl}/runs/flush-run/agents/agent-a/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reportEnvelope('flush-run', 'agent-a', 'target-report', targetMarker)),
    });
    assertEquals(targetResponse.status, 202);

    const jsonlResponse = await fetch(`${server.baseUrl}/runs/flush-run/events.jsonl`);
    assertEquals(jsonlResponse.status, 200);
    assert(
      (await jsonlResponse.text()).includes(targetMarker),
      'direct JSONL response should include a report after its upload has been accepted',
    );
  } finally {
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('control server dedupes final report artifact JSONL rows across WS and HTTP', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-artifact-dedupe-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
    RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS: '0',
  });
  let socket: WebSocket | undefined;
  try {
    socket = await registerAgent(server.baseUrl, 'dedupe-run', 'agent-a');
    const report = reportEnvelope(
      'dedupe-run',
      'agent-a',
      'final-report-duplicate',
      'artifact-report-dedupe-marker',
    );
    socket.send(JSON.stringify(report));
    await waitForJsonl(server.baseUrl, '/runs/dedupe-run/events.jsonl', 'final-report-duplicate');

    const uploadResponse = await fetch(`${server.baseUrl}/runs/dedupe-run/agents/agent-a/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    assertEquals(uploadResponse.status, 202);

    const eventsResponse = await fetch(`${server.baseUrl}/runs/dedupe-run/events.jsonl`);
    assertEquals(eventsResponse.status, 200);
    const reportRows = (await eventsResponse.text())
      .trim()
      .split(/\r?\n/g)
      .filter((line) => line.includes('final-report-duplicate'));
    assertEquals(reportRows.length, 1);
  } finally {
    socket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('control server read token mode protects run, fleet, and distributed GET routes', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
  });
  try {
    const health = await getJson<HealthResponse>(server.baseUrl, '/health');
    assertEquals(health.ok, true);

    const openApi = await fetch(`${server.baseUrl}/api/openapi.json`);
    assertEquals(openApi.status, 200);

    for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
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

Deno.test('control server read token mode fails closed without an auth backend', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const server = await startControlServer({
    RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
  });
  try {
    const health = await getJson<HealthResponse>(server.baseUrl, '/health');
    assertEquals(health.ok, true);

    for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
      const unauthorized = await fetch(`${server.baseUrl}${path}`);
      assertEquals(unauthorized.status, 401);
    }
  } finally {
    await server.stop();
  }
});

Deno.test('control server distributed and fleet APIs validate auth, artifacts, filters, and persisted restore', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-api-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: OPERATOR_TOKEN_SECRET,
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let agentSocket: WebSocket | undefined;
  try {
    agentSocket = await registerAgent(server.baseUrl, 'api-control-run', 'agent-a');

    const unauthorizedCreate = await fetch(`${server.baseUrl}/distributed-runs`, {
      method: 'POST',
      body: JSON.stringify({ manifest: distributedManifest() }),
    });
    assertEquals(unauthorizedCreate.status, 401);

    const expiredOperatorToken = await operatorToken({
      expiresAtEpochMs: Date.now() - 1_000,
    });
    const expiredCreate = await fetch(`${server.baseUrl}/distributed-runs`, {
      method: 'POST',
      headers: bearerJsonHeaders(expiredOperatorToken),
      body: JSON.stringify({ manifest: distributedManifest() }),
    });
    assertEquals(expiredCreate.status, 401);

    const wrongScopeOperatorToken = await operatorToken({
      claims: { scope: 'wrong-scope' as never },
    });
    const wrongScopeCreate = await fetch(`${server.baseUrl}/distributed-runs`, {
      method: 'POST',
      headers: bearerJsonHeaders(wrongScopeOperatorToken),
      body: JSON.stringify({ manifest: distributedManifest() }),
    });
    assertEquals(wrongScopeCreate.status, 401);

    const signedOperatorToken = await operatorToken();
    const previewResponse = await fetch(`${server.baseUrl}/distributed-runs/resolve-targets`, {
      method: 'POST',
      headers: bearerJsonHeaders(signedOperatorToken),
      body: JSON.stringify({
        manifest: {
          ...distributedManifest(),
          targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1,
          },
          roleAssignmentPolicy: {
            mode: 'ordered-targets',
            pattern: 'one-sender-many-receivers',
            orderBy: 'agent-id',
          },
        },
      }),
    });
    assertEquals(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      targetAgentIds: readonly string[];
      summary: {
        selected: number;
        expectedParticipantCount?: number;
        roleCounts: Record<string, number>;
      };
    };
    assertEquals(preview.targetAgentIds, ['agent-a']);
    assertEquals(preview.summary.selected, 1);
    assertEquals(preview.summary.expectedParticipantCount, 1);
    assertEquals(preview.summary.roleCounts, { sender: 1 });

    const createdResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
      method: 'POST',
      headers: bearerJsonHeaders(signedOperatorToken),
      body: JSON.stringify({ manifest: distributedManifest() }),
    });
    assertEquals(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      distributedRunId: string;
      targetAgentIds: readonly string[];
    };
    assertEquals(created.distributedRunId, 'api-dist-1');
    assertEquals(created.targetAgentIds, ['agent-a']);

    const stagedResponse = await fetch(`${server.baseUrl}/distributed-runs/api-dist-1/stage`, {
      method: 'POST',
      headers: bearerJsonHeaders(signedOperatorToken),
    });
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
    assertEquals(staged.state, 'waiting-for-ack');
    assertEquals(staged.commandLinks.length, 1);
    assertEquals(staged.commandLinks[0].phase, 'stage');
    assertEquals(staged.commandLinks[0].agentId, 'agent-a');
    assertEquals(staged.commandLinks[0].recipeId, 'api-health');

    const startedResponse = await fetch(`${server.baseUrl}/distributed-runs/api-dist-1/start`, {
      method: 'POST',
      headers: bearerJsonHeaders(signedOperatorToken),
    });
    assertEquals(startedResponse.status, 202);
    const started = await startedResponse.json() as { state: string };
    assertEquals(started.state, 'waiting-for-ack');

    const distributed = await getJson(server.baseUrl, '/distributed-runs/api-dist-1') as {
      state: string;
      manifest: { distributedRunId: string };
    };
    assertEquals(distributed.manifest.distributedRunId, 'api-dist-1');

    const distributedArtifact = await getJson(
      server.baseUrl,
      '/distributed-runs/api-dist-1/artifacts',
    ) as {
      artifactSchemaVersion: number;
      files: Record<string, string>;
    };
    assertEquals(distributedArtifact.artifactSchemaVersion, 2);
    assert(distributedArtifact.files['manifest.json'].includes('api-dist-1'));
    assert('metadata.json' in distributedArtifact.files);

    const fleet = await getJson(server.baseUrl, '/fleet/reports?region=eu-north') as {
      reports: readonly unknown[];
      aggregate: { runCount: number };
    };
    assertEquals(fleet.reports.length, 0);
    assertEquals(fleet.aggregate.runCount, 0);

    const unauthorizedRebuild = await fetch(`${server.baseUrl}/fleet/reports/rebuild`, {
      method: 'POST',
    });
    assertEquals(unauthorizedRebuild.status, 401);
    const rebuildResponse = await fetch(`${server.baseUrl}/fleet/reports/rebuild`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    assertEquals(rebuildResponse.status, 200);

    await waitForPersistedSnapshot(storageDir, 'api-dist-1');
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
    const restoredRun = await getJson(restored.baseUrl, '/distributed-runs/api-dist-1') as {
      distributedRunId: string;
      state: string;
    };
    assertEquals(restoredRun.distributedRunId, 'api-dist-1');
    assertEquals(restoredRun.state, 'failed');
  } finally {
    await restored.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('retention preview is authorized non-destructive and guarded before cleanup', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-retention-api-' });
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
        runs: [run('retention-old', 1_000), run('retention-new', 2_000)],
        distributedRuns: [{
          distributedRunId: 'retention-dist-old',
          controlRunId: 'retention-old',
          manifest: {
            distributedRunId: 'retention-dist-old',
            controlRunId: 'retention-old',
            group: {
              applicationId: 'rallar-server',
              workspaceId: 'default',
              groupId: 'retention-group',
            },
            recipes: [],
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
          },
          state: 'failed',
          createdAtEpochMs: 1_000,
          updatedAtEpochMs: 1_000,
          targetAgentIds: [],
          commandLinks: [],
          rollup: {
            state: 'failed',
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
          distributedRunId: 'retention-dist-old',
          controlRunId: 'retention-old',
          generatedAtEpochMs: 2_000,
          state: 'failed',
          ok: false,
          group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'retention-group',
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
            distributedRun: '/distributed-runs/retention-dist-old',
            controlRun: '/runs/retention-old',
            fleetReport: '/fleet/reports/retention-dist-old',
          },
        }],
      },
    }),
  );
  const artifactDir = `${storageDir}/runs/retention-old`;
  const artifactPath = `${artifactDir}/sentinel.jsonl`;
  await Deno.mkdir(artifactDir, { recursive: true });
  await Deno.writeTextFile(artifactPath, 'manual-cleanup-must-preserve-this\n');
  const beforePreview = await Deno.readTextFile(snapshotPath);
  const server = await startControlServer({
    RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
    RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: '8',
    RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let unregisteredSocket: WebSocket | undefined;
  try {
    unregisteredSocket = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/control`);
    await waitForSocketOpen(unregisteredSocket);
    const unauthorizedBody = { error: 'Admin token is required or invalid.' };
    for (
      const query of [
        '?dryRun=true',
        '?dryRun=false',
        '?dryRun=true&dryRun=true',
        '?planToken=v1.abc.def',
        '?planToken=v1.abc.def&planToken=v1.abc.def',
        '?dryRun=true&planToken=v1.abc.def',
        `?planToken=${'a'.repeat(513)}`,
        '?planToken=v1.abc.def&token=v1.abc.def',
      ]
    ) {
      const unauthorized = await fetch(`${server.baseUrl}/retention/cleanup${query}`, {
        method: 'POST',
      });
      assertEquals(unauthorized.status, 401);
      assertEquals(await unauthorized.json(), unauthorizedBody);
    }

    for (
      const query of [
        '?dryRun=false',
        '?dryRun=',
        '?dryRun=true&dryRun=true',
        '?planToken=',
        '?planToken=v1.abc.def&planToken=v1.abc.def',
        '?dryRun=true&planToken=v1.abc.def',
        `?planToken=${'a'.repeat(513)}`,
      ]
    ) {
      const invalid = await fetch(`${server.baseUrl}/retention/cleanup${query}`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      assertEquals(invalid.status, 400);
    }

    const previewResponse = await fetch(`${server.baseUrl}/retention/cleanup?dryRun=true`, {
      method: 'POST',
      headers: adminHeaders(),
      body: '{ malformed and intentionally larger than the request body limit',
    });
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
        distributedRuns: readonly unknown[];
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
      runId: 'retention-old',
      createdAtEpochMs: 1_000,
      updatedAtEpochMs: 1_000,
      connectedAgentCount: 0,
      issuedRunTokenCount: 0,
      distributedRuns: [{
        distributedRunId: 'retention-dist-old',
        state: 'failed',
      }],
      fleetReportIds: ['retention-dist-old'],
    }]);
    assertEquals(preview.wouldDeleteRunIds, ['retention-old']);
    assertEquals(preview.wouldDeleteDistributedRunIds, ['retention-dist-old']);
    assertEquals(preview.wouldDeleteFleetReportIds, ['retention-dist-old']);
    assertEquals(preview.preserves, {
      connectedAgentSockets: true,
      storedArtifactFiles: true,
    });
    assert(typeof preview.planToken === 'string' && preview.planToken.length > 0);
    assert(!JSON.stringify(preview).includes('revision:'));
    assert(!JSON.stringify(preview).includes('canonicalConsequence'));
    assertEquals(await Deno.readTextFile(snapshotPath), beforePreview);
    assertEquals(await Deno.readTextFile(artifactPath), 'manual-cleanup-must-preserve-this\n');
    assertEquals(unregisteredSocket.readyState, WebSocket.OPEN);
    assertEquals(
      (await getJson<{ runs: readonly unknown[] }>(server.baseUrl, '/runs')).runs.length,
      2,
    );

    const tamperedToken = `${preview.planToken.slice(0, -1)}${
      preview.planToken.endsWith('A') ? 'B' : 'A'
    }`;
    const staleBody = {
      error: 'Retention preview is stale, expired, or belongs to another server process.',
    };
    const tampered = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(tamperedToken)}`,
      { method: 'POST', headers: adminHeaders() },
    );
    assertEquals(tampered.status, 409);
    assertEquals(await tampered.json(), staleBody);
    assertEquals(
      (await getJson<{ runs: readonly unknown[] }>(server.baseUrl, '/runs')).runs.length,
      2,
    );

    const unauthorizedIssuedToken = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
      { method: 'POST' },
    );
    assertEquals(unauthorizedIssuedToken.status, 401);
    assertEquals(await unauthorizedIssuedToken.json(), unauthorizedBody);

    const otherStorageDir = await Deno.makeTempDir({ prefix: 'rallar-retention-other-' });
    await Deno.writeTextFile(`${otherStorageDir}/control-snapshot.json`, beforePreview);
    const otherServer = await startControlServer({
      RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
      RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
      RALLAR_BLACK_BOX_STORAGE_DIR: otherStorageDir,
    });
    try {
      const wrongProcess = await fetch(
        `${otherServer.baseUrl}/retention/cleanup?planToken=${
          encodeURIComponent(preview.planToken)
        }`,
        { method: 'POST', headers: adminHeaders() },
      );
      assertEquals(wrongProcess.status, 409);
      assertEquals(await wrongProcess.json(), staleBody);
      assertEquals(
        (await getJson<{ runs: readonly unknown[] }>(otherServer.baseUrl, '/runs')).runs.length,
        2,
      );
    } finally {
      await otherServer.stop();
      await Deno.remove(otherStorageDir, { recursive: true });
    }

    const confirmResponse = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
      {
        method: 'POST',
        headers: adminHeaders(),
        body: '{ malformed and intentionally larger than the request body limit',
      },
    );
    assertEquals(confirmResponse.status, 200);
    assertEquals(await confirmResponse.json(), {
      deletedRunIds: ['retention-old'],
      retainedRuns: 1,
      maxRuns: 1,
    });
    assertEquals(await Deno.readTextFile(artifactPath), 'manual-cleanup-must-preserve-this\n');
    assertEquals(unregisteredSocket.readyState, WebSocket.OPEN);
    assertEquals(
      (await getJson<{ distributedRuns: readonly unknown[] }>(server.baseUrl, '/distributed-runs'))
        .distributedRuns.length,
      0,
    );
    assertEquals(
      (await getJson<{ reports: readonly unknown[] }>(server.baseUrl, '/fleet/reports')).reports
        .length,
      0,
    );

    const reused = await fetch(
      `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
      { method: 'POST', headers: adminHeaders() },
    );
    assertEquals(reused.status, 409);
    assertEquals(await reused.json(), staleBody);

    const legacy = await fetch(`${server.baseUrl}/retention/cleanup?unknown=value`, {
      method: 'POST',
      headers: adminHeaders(),
      body: '{ malformed and intentionally larger than the request body limit',
    });
    assertEquals(legacy.status, 200);
    assertEquals(await legacy.json(), {
      deletedRunIds: [],
      retainedRuns: 1,
      maxRuns: 1,
    });
    assertEquals(await Deno.readTextFile(artifactPath), 'manual-cleanup-must-preserve-this\n');
  } finally {
    unregisteredSocket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

Deno.test('automatic retention still closes deleted-run sockets and artifact files', async () => {
  if (!(await canBindLoopback())) {
    return;
  }

  const storageDir = await Deno.makeTempDir({ prefix: 'rallar-auto-retention-' });
  const server = await startControlServer({
    RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
    RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
  });
  let oldSocket: WebSocket | undefined;
  let newSocket: WebSocket | undefined;
  try {
    oldSocket = await registerAgent(server.baseUrl, 'auto-old', 'agent-old');
    const oldArtifactDir = `${storageDir}/runs/auto-old`;
    await Deno.mkdir(oldArtifactDir, { recursive: true });
    await Deno.writeTextFile(`${oldArtifactDir}/sentinel.jsonl`, 'remove-on-auto-prune\n');

    const oldSocketClose = waitForSocketClose(oldSocket);
    newSocket = await registerAgent(server.baseUrl, 'auto-new', 'agent-new');
    const close = await oldSocketClose;

    assertEquals(close.code, 1000);
    assertEquals(close.reason, 'run deleted');
    await waitForPathMissing(oldArtifactDir);
    const runs = await getJson<{ runs: readonly { runId: string }[] }>(server.baseUrl, '/runs');
    assertEquals(runs.runs.map((run) => run.runId), ['auto-new']);
    assertEquals(newSocket.readyState, WebSocket.OPEN);
  } finally {
    oldSocket?.close();
    newSocket?.close();
    await server.stop();
    await Deno.remove(storageDir, { recursive: true });
  }
});

let loopbackBindAvailable: Promise<boolean> | undefined;

function canBindLoopback(): Promise<boolean> {
  loopbackBindAvailable ??= (async () => {
    try {
      const listener = Deno.listen({
        hostname: '127.0.0.1',
        port: 0,
      });
      listener.close();
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.PermissionDenied) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Operation not permitted')) {
        return false;
      }
      throw error;
    }
  })();
  return loopbackBindAvailable;
}

async function startControlServer(env: Record<string, string> = {}): Promise<StartedControlServer> {
  const storageDir = env.RALLAR_BLACK_BOX_STORAGE_DIR ?? await Deno.makeTempDir({
    prefix: 'rallar-control-api-',
  });
  const port = randomPort();
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      'src/main.ts',
    ],
    cwd: CONTROL_ROOT,
    stdin: 'null',
    stdout: 'null',
    stderr: 'piped',
    env: {
      RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '0',
      ...env,
      PORT: String(port),
      RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
    },
  });
  const child = command.spawn();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    const status = await stopChild(child);
    const stderr = await new Response(child.stderr).text().catch(() => '');
    throw new Error(
      `Control server did not start. ${error instanceof Error ? error.message : String(error)}\n` +
        `status=${JSON.stringify(status)}\n${stderr}`,
    );
  }
  return {
    baseUrl,
    storageDir,
    async stop() {
      await stopChild(child);
    },
  };
}

async function stopChild(child: Deno.ChildProcess): Promise<Deno.CommandStatus | undefined> {
  try {
    child.kill('SIGTERM');
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }
  return await child.status.catch(() => undefined);
}

function adminHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'content-type': 'application/json',
  };
}

function bearerJsonHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function operatorToken(
  input: Readonly<{
    expiresAtEpochMs?: number;
    claims?: Parameters<typeof signRallarBlackBoxOperatorToken>[0]['claims'];
  }> = {},
): Promise<string> {
  const issuedAtEpochMs = Date.now() - 1_000;
  return await signRallarBlackBoxOperatorToken({
    secret: OPERATOR_TOKEN_SECRET,
    subject: 'alice',
    sessionId: 'alice-session',
    issuedAtEpochMs,
    expiresAtEpochMs: input.expiresAtEpochMs ?? issuedAtEpochMs + 60_000,
    tokenId: 'operator-token-id',
    claims: input.claims,
  });
}

async function registerAgent(baseUrl: string, runId: string, agentId: string): Promise<WebSocket> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/control`);
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({
    kind: 'register',
    protocolVersion: 1,
    runId,
    agentId,
    atEpochMs: Date.now(),
    identity: {
      applicationId: 'rallar-server',
      workspaceId: 'default',
      groupId: 'bb-group',
      region: 'eu-north',
      provider: 'black-box-test',
    },
    resume: {
      completedCommandIds: [],
    },
  }));
  await waitForAgent(baseUrl, runId, agentId);
  return socket;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not open.')), 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket failed to open.'));
    }, { once: true });
  });
}

function waitForSocketClose(socket: WebSocket): Promise<CloseEvent> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(new CloseEvent('close', { code: 1000 }));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not close.')), 5_000);
    socket.addEventListener('close', (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket failed before close.'));
    }, { once: true });
  });
}

async function waitForAgent(baseUrl: string, runId: string, agentId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (response.ok) {
      const run = await response.json() as {
        agents?: readonly { agentId: string; connected: boolean }[];
      };
      if (run.agents?.some((agent) => agent.agentId === agentId && agent.connected)) {
        return;
      }
    }
    await delay(50);
  }
  throw new Error(`Agent ${agentId} did not register for ${runId}.`);
}

async function waitForJsonl(baseUrl: string, path: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let lastText = '';
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}${path}`);
    if (response.ok) {
      lastText = await response.text();
      if (lastText.includes(marker)) {
        return lastText;
      }
    }
    await delay(50);
  }
  throw new Error(`JSONL ${path} did not include ${marker}. Last body: ${lastText}`);
}

async function getJson<TValue = unknown>(baseUrl: string, path: string): Promise<TValue> {
  const response = await fetch(`${baseUrl}${path}`);
  assertEquals(response.status, 200);
  return await response.json() as TValue;
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Control server did not become healthy: ${lastError}`);
}

async function waitForPersistedSnapshot(storageDir: string, marker: string): Promise<void> {
  const path = `${storageDir}/control-snapshot.json`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = await Deno.readTextFile(path);
      if (text.includes(marker)) {
        return;
      }
    } catch (_error) {
      // Persisting happens asynchronously after each write request.
    }
    await delay(50);
  }
  throw new Error(`Persisted snapshot did not include ${marker}.`);
}

async function waitForPathMissing(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Path was not removed: ${path}`);
}

function reportEnvelope(
  runId: string,
  agentId: string,
  eventId: string,
  marker: string,
  padding = '',
): unknown {
  return {
    kind: 'report',
    protocolVersion: 1,
    runId,
    agentId,
    atEpochMs: Date.now(),
    eventId,
    payload: {
      kind: 'report',
      topic: 'rallar.bb.report.final',
      payload: {
        reportId: eventId,
        summary: { reason: marker },
        stats: { padding },
      },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return 20_000 + (buffer[0] % 20_000);
}

function distributedManifest() {
  return {
    schemaVersion: 1,
    distributedRunId: 'api-dist-1',
    controlRunId: 'api-control-run',
    group: {
      applicationId: 'rallar-server',
      workspaceId: 'default',
      groupId: 'bb-group',
    },
    recipes: [
      {
        recipeId: 'api-health',
        recipe: {
          recipeId: 'api-health',
          commands: [
            {
              kind: 'health',
              commandId: 'api-health-command',
            },
          ],
        },
      },
    ],
    targetPolicy: {
      mode: 'selected-agents',
      agentIds: ['agent-a'],
    },
    startMode: 'manual',
    ackTimeoutMs: 1_000,
  };
}
