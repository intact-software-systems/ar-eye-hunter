const CONTROL_ROOT = new URL('..', import.meta.url).pathname;
const ADMIN_TOKEN = 'black-box-admin-token';

type StartedControlServer = Readonly<{
    baseUrl: string;
    storageDir: string;
    stop(): Promise<void>;
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
    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
        RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1',
    });
    try {
        const health = await getJson(server.baseUrl, '/health');
        assertEquals(health.ok, true);
        assertEquals(health.app, 'rallar-black-box-control-server');

        const unauthorizedCommand = await fetch(`${server.baseUrl}/runs/http-run/agents/agent-a/commands`, {
            method: 'POST',
            body: JSON.stringify({
                commandId: 'health-unauthorized',
                command: { kind: 'health', commandId: 'health-unauthorized' },
            }),
        });
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
        assertEquals(bulkAccepted.commands?.map(command => command.commandId), [
            'bulk-health-agent-a',
            'bulk-health-agent-b',
        ]);

        const run = await getJson(server.baseUrl, '/runs/http-run?limitCommands=2') as {
            commands: readonly { envelope: { commandId: string } }[];
        };
        assertEquals(run.commands.map(command => command.envelope.commandId), [
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

Deno.test('control server distributed and fleet APIs validate auth, artifacts, filters, and persisted restore', async () => {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-api-' });
    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
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

        const createdResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
            method: 'POST',
            headers: adminHeaders(),
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
            headers: adminHeaders(),
        });
        assertEquals(stagedResponse.status, 202);
        const staged = await stagedResponse.json() as {
            state: string;
            commandLinks: readonly { phase: string; agentId: string; commandId: string; recipeId?: string }[];
        };
        assertEquals(staged.state, 'waiting-for-ack');
        assertEquals(staged.commandLinks.length, 1);
        assertEquals(staged.commandLinks[0].phase, 'stage');
        assertEquals(staged.commandLinks[0].agentId, 'agent-a');
        assertEquals(staged.commandLinks[0].recipeId, 'api-health');

        const distributed = await getJson(server.baseUrl, '/distributed-runs/api-dist-1') as {
            state: string;
            manifest: { distributedRunId: string };
        };
        assertEquals(distributed.manifest.distributedRunId, 'api-dist-1');

        const distributedArtifact = await getJson(server.baseUrl, '/distributed-runs/api-dist-1/artifacts') as {
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

        const unauthorizedRebuild = await fetch(`${server.baseUrl}/fleet/reports/rebuild`, { method: 'POST' });
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
            ...env,
            PORT: String(port),
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
            RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '0',
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

async function waitForAgent(baseUrl: string, runId: string, agentId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
        if (response.ok) {
            const run = await response.json() as { agents?: readonly { agentId: string; connected: boolean }[] };
            if (run.agents?.some(agent => agent.agentId === agentId && agent.connected)) {
                return;
            }
        }
        await delay(50);
    }
    throw new Error(`Agent ${agentId} did not register for ${runId}.`);
}

async function getJson(baseUrl: string, path: string): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`);
    assertEquals(response.status, 200);
    return await response.json();
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

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
