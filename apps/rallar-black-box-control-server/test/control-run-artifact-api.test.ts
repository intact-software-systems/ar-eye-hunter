import { assert, assertEquals } from '@std/assert';

import { registerAgent, waitForJsonl, waitForSocketClose, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { reportEnvelope } from './support/control-api-test-fixtures.ts';
import { ADMIN_TOKEN, adminHeaders, canBindLoopback, getJson, startControlServer } from './support/control-api-test-server.ts';

interface HealthResponse {
    readonly ok?: boolean;
    readonly app?: string;
}

Deno.test('REST API enforces tokens, queues commands, and exports run artifacts', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
        RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1'
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
                    command: { kind: 'health', commandId: 'health-unauthorized' }
                })
            }
        );
        assertEquals(unauthorizedCommand.status, 401);

        const tokenResponse = await fetch(
            `${server.baseUrl}/runs/http-run/agents/agent-a/tokens`,
            {
                method: 'POST',
                headers: adminHeaders(),
                body: JSON.stringify({ ttlMs: 60_000 })
            }
        );
        assertEquals(tokenResponse.status, 201);
        const token = await tokenResponse.json() as { token: string; };
        assert(token.token.length > 12);

        const commandResponse = await fetch(
            `${server.baseUrl}/runs/http-run/agents/agent-a/commands`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-rallar-run-token': token.token
                },
                body: JSON.stringify({
                    commandId: 'health-1',
                    command: { kind: 'health', commandId: 'health-1' }
                })
            }
        );
        assertEquals(commandResponse.status, 202);
        const commandAccepted = await commandResponse.json() as {
            accepted?: boolean;
            command?: { commandId?: string; };
        };
        assertEquals(commandAccepted.accepted, true);
        assertEquals(commandAccepted.command?.commandId, 'health-1');

        const bulkResponse = await fetch(
            `${server.baseUrl}/runs/http-run/commands`,
            {
                method: 'POST',
                headers: adminHeaders(),
                body: JSON.stringify({
                    agentIds: ['agent-a', 'agent-b'],
                    commandIdPrefix: 'bulk-health',
                    command: { kind: 'health' }
                })
            }
        );
        assertEquals(bulkResponse.status, 202);
        const bulkAccepted = await bulkResponse.json() as {
            commands?: readonly { commandId: string; agentId?: string; }[];
        };
        assertEquals(bulkAccepted.commands?.map((command) => command.commandId), [
            'bulk-health-agent-a',
            'bulk-health-agent-b'
        ]);

        const runResponse = await fetch(
            `${server.baseUrl}/runs/http-run?limitCommands=2`
        );
        assertEquals(runResponse.status, 200);
        const runText = await runResponse.text();
        assert(
            !runText.includes('\n'),
            'High-frequency control JSON responses should use compact serialization.'
        );
        const run = JSON.parse(runText) as {
            commands: readonly { envelope: { commandId: string; }; }[];
        };
        assertEquals(run.commands.map((command) => command.envelope.commandId), [
            'bulk-health-agent-a',
            'bulk-health-agent-b'
        ]);

        const artifact = await getJson<{
            artifactSchemaVersion: number;
            files: Record<string, string>;
        }>(server.baseUrl, '/runs/http-run/artifacts');
        assertEquals(artifact.artifactSchemaVersion, 1);
        const artifactReport = JSON.parse(artifact.files['report.json']) as {
            outputs?: { commandCount?: number; };
        };
        assertEquals(artifactReport.outputs?.commandCount, 3);

        const reportFile = await fetch(
            `${server.baseUrl}/runs/http-run/artifacts/report.json`
        );
        assertEquals(reportFile.status, 200);
        assert(
            reportFile.headers.get('content-type')?.includes('application/json')
        );

        const missingFile = await fetch(
            `${server.baseUrl}/runs/http-run/artifacts/unknown.json`
        );
        assertEquals(missingFile.status, 404);
    }
    finally {
        await server.stop();
    }
});

Deno.test('HTTP and WebSocket agent ingress reject oversized payloads', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const server = await startControlServer({
        RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: '256'
    });
    try {
        const oversizedReport = await fetch(
            `${server.baseUrl}/runs/run-big/agents/agent-a/report`,
            {
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
                            results: [{ value: 'x'.repeat(512) }]
                        }
                    }
                })
            }
        );
        assertEquals(oversizedReport.status, 413);

        const socket = new WebSocket(
            `${server.baseUrl.replace(/^http/, 'ws')}/control`
        );
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
                value: 'x'.repeat(512)
            }
        }));
        assertEquals((await closed).code, 1009);
    }
    finally {
        await server.stop();
    }
});

Deno.test('artifact JSONL retains full evidence after runtime trimming', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({
        prefix: 'rallar-control-artifacts-'
    });
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0'
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
                details: { value: 'x'.repeat(1024) }
            }
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
                value: 'y'.repeat(1024)
            }
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
                    summary: { reason: 'trimmed-agent' },
                    events: [{ eventId: 'report-heavy', value: 'z'.repeat(1024) }]
                }
            }
        }));

        await waitForJsonl(
            server.baseUrl,
            '/runs/trim-run/results.jsonl',
            'HEAVY_FAILURE'
        );
        await waitForJsonl(
            server.baseUrl,
            '/runs/trim-run/events.jsonl',
            'heavy-event'
        );
        await waitForJsonl(
            server.baseUrl,
            '/runs/trim-run/events.jsonl',
            'report-heavy'
        );
        const artifactResults = await fetch(
            `${server.baseUrl}/runs/trim-run/artifacts/results.jsonl`
        );
        assertEquals(artifactResults.status, 200);
        assert(
            (await artifactResults.text()).includes('HEAVY_FAILURE'),
            'Per-file results artifacts should stream the stored JSONL evidence.'
        );

        const snapshot = await getJson<{
            results?: readonly object[];
            events?: readonly object[];
            reports?: readonly object[];
        }>(server.baseUrl, '/runs/trim-run');
        assertEquals(snapshot.results?.length, 0);
        assertEquals(snapshot.events?.length, 0);
        assertEquals(snapshot.reports?.length, 1);
        assertEquals(
            JSON.stringify(snapshot.reports).includes('report-heavy'),
            false
        );
    }
    finally {
        socket?.close();
        await server.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('disk-backed result and event rows retain command metadata', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({
        prefix: 'rallar-control-artifact-metadata-'
    });
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0'
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
                        send: { text: 'hello' }
                    }
                })
            }
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
                value: { delivered: true }
            }
        }));

        const resultsText = await waitForJsonl(
            server.baseUrl,
            '/runs/metadata-run/results.jsonl',
            'rtc-send-1'
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
            'rtc-send-1'
        );
        const stepResult = eventsText
            .trim()
            .split(/\r?\n/g)
            .map((line) =>
                JSON.parse(line) as {
                    kind?: string;
                    action?: string;
                    transport?: string;
                }
            )
            .find((row) => row.kind === 'step-result');
        assert(stepResult);
        assertEquals(stepResult.action, 'rtc.send');
        assertEquals(stepResult.transport, 'messages.rtc');
    }
    finally {
        socket?.close();
        await server.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('artifact JSONL responses wait for queued writes', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({
        prefix: 'rallar-control-artifact-flush-'
    });
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: '2000000',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS: '0'
    });
    try {
        const seedMarker = 'artifact-flush-seed';
        const seedResponse = await fetch(
            `${server.baseUrl}/runs/flush-run/agents/agent-a/report`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(reportEnvelope({
                    runId: 'flush-run',
                    agentId: 'agent-a',
                    eventId: 'seed-report',
                    marker: seedMarker
                }))
            }
        );
        assertEquals(seedResponse.status, 202);
        await waitForJsonl(
            server.baseUrl,
            '/runs/flush-run/events.jsonl',
            seedMarker
        );

        const backlogResponses = await Promise.all(
            Array.from(
                { length: 6 },
                (_, index) =>
                    fetch(`${server.baseUrl}/runs/flush-run/agents/agent-a/report`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(reportEnvelope({
                            runId: 'flush-run',
                            agentId: 'agent-a',
                            eventId: `backlog-report-${index}`,
                            marker: `artifact-flush-backlog-${index}`,
                            padding: 'x'.repeat(1_500_000)
                        }))
                    })
            )
        );
        for (const response of backlogResponses) {
            assertEquals(response.status, 202);
        }

        const targetMarker = 'artifact-flush-target';
        const targetResponse = await fetch(
            `${server.baseUrl}/runs/flush-run/agents/agent-a/report`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(reportEnvelope({
                    runId: 'flush-run',
                    agentId: 'agent-a',
                    eventId: 'target-report',
                    marker: targetMarker
                }))
            }
        );
        assertEquals(targetResponse.status, 202);

        const jsonlResponse = await fetch(
            `${server.baseUrl}/runs/flush-run/events.jsonl`
        );
        assertEquals(jsonlResponse.status, 200);
        assert(
            (await jsonlResponse.text()).includes(targetMarker),
            'Direct JSONL responses should include accepted report uploads.'
        );
    }
    finally {
        await server.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('final report artifact rows dedupe across WebSocket and HTTP ingress', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({
        prefix: 'rallar-control-artifact-dedupe-'
    });
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS: '0'
    });
    let socket: WebSocket | undefined;
    try {
        socket = await registerAgent(server.baseUrl, 'dedupe-run', 'agent-a');
        const report = reportEnvelope({
            runId: 'dedupe-run',
            agentId: 'agent-a',
            eventId: 'final-report-duplicate',
            marker: 'artifact-report-dedupe-marker'
        });
        socket.send(JSON.stringify(report));
        await waitForJsonl(
            server.baseUrl,
            '/runs/dedupe-run/events.jsonl',
            'final-report-duplicate'
        );

        const uploadResponse = await fetch(
            `${server.baseUrl}/runs/dedupe-run/agents/agent-a/report`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(report)
            }
        );
        assertEquals(uploadResponse.status, 202);

        const eventsResponse = await fetch(
            `${server.baseUrl}/runs/dedupe-run/events.jsonl`
        );
        assertEquals(eventsResponse.status, 200);
        const reportRows = (await eventsResponse.text())
            .trim()
            .split(/\r?\n/g)
            .filter((line) => line.includes('final-report-duplicate'));
        assertEquals(reportRows.length, 1);
    }
    finally {
        socket?.close();
        await server.stop();
        await Deno.remove(storageDir, { recursive: true });
    }
});
