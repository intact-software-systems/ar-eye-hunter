import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './support/assert.ts';

import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES
} from '@shared-test/rallar-bb-test/control-protocol.ts';

import { registerAgent, waitForJsonl, waitForSocketClose, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { reportEnvelope } from './support/control-api-test-fixtures.ts';
import { ADMIN_TOKEN, adminHeaders, canBindLoopback, getJson, startControlServer } from './support/control-api-test-server.ts';

interface HealthResponse {
    readonly ok?: boolean;
    readonly app?: string;
}

test('REST API enforces tokens, queues commands, and exports run artifacts', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
        RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1'
    });
    try {
        const health = await getJson<HealthResponse>(server.baseUrl, '/health');
        expect(health.ok).toEqual(true);
        expect(health.app).toEqual('rallar-black-box-control-server');

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
        expect(unauthorizedCommand.status).toEqual(401);

        const tokenResponse = await fetch(
            `${server.baseUrl}/runs/http-run/agents/agent-a/tokens`,
            {
                method: 'POST',
                headers: adminHeaders(),
                body: JSON.stringify({ ttlMs: 60_000 })
            }
        );
        expect(tokenResponse.status).toEqual(201);
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
        expect(commandResponse.status).toEqual(202);
        const commandAccepted = await commandResponse.json() as {
            accepted?: boolean;
            command?: { commandId?: string; };
        };
        expect(commandAccepted.accepted).toEqual(true);
        expect(commandAccepted.command?.commandId).toEqual('health-1');

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
        expect(bulkResponse.status).toEqual(202);
        const bulkAccepted = await bulkResponse.json() as {
            commands?: readonly { commandId: string; agentId?: string; }[];
        };
        expect(bulkAccepted.commands?.map((command) => command.commandId)).toEqual([
            'bulk-health-agent-a',
            'bulk-health-agent-b'
        ]);

        const runResponse = await fetch(
            `${server.baseUrl}/runs/http-run?limitCommands=2`
        );
        expect(runResponse.status).toEqual(200);
        const runText = await runResponse.text();
        assert(!runText.includes('\n'));
        const run = JSON.parse(runText) as {
            commands: readonly { envelope: { commandId: string; }; }[];
        };
        expect(run.commands.map((command) => command.envelope.commandId)).toEqual([
            'bulk-health-agent-a',
            'bulk-health-agent-b'
        ]);

        const artifact = await getJson<{
            artifactSchemaVersion: number;
            files: Record<string, string>;
        }>(server.baseUrl, '/runs/http-run/artifacts');
        expect(artifact.artifactSchemaVersion).toEqual(1);
        const artifactReport = JSON.parse(artifact.files['report.json']) as {
            outputs?: { commandCount?: number; };
        };
        expect(artifactReport.outputs?.commandCount).toEqual(3);

        const reportFile = await fetch(
            `${server.baseUrl}/runs/http-run/artifacts/report.json`
        );
        expect(reportFile.status).toEqual(200);
        assert(reportFile.headers.get('content-type')?.includes('application/json'));

        const missingFile = await fetch(
            `${server.baseUrl}/runs/http-run/artifacts/unknown.json`
        );
        expect(missingFile.status).toEqual(404);
    }
    finally {
        await server.stop();
    }
});

test('HTTP and WebSocket agent ingress reject oversized payloads', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const server = await startControlServer();
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
                            results: [{ value: 'x'.repeat(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES) }]
                        }
                    }
                })
            }
        );
        expect(oversizedReport.status).toEqual(413);

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
                value: 'x'.repeat(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES)
            }
        }));
        expect((await closed).code).toEqual(1009);
    }
    finally {
        await server.stop();
    }
});

test('artifact JSONL retains full evidence after runtime trimming', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-artifacts-'));
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
        expect(artifactResults.status).toEqual(200);
        assert((await artifactResults.text()).includes('HEAVY_FAILURE'));

        const snapshot = await getJson<{
            results?: readonly object[];
            events?: readonly object[];
            reports?: readonly object[];
        }>(server.baseUrl, '/runs/trim-run');
        expect(snapshot.results?.length).toEqual(0);
        expect(snapshot.events?.length).toEqual(0);
        expect(snapshot.reports?.length).toEqual(1);
        expect(JSON.stringify(snapshot.reports).includes('report-heavy')).toEqual(false);
    }
    finally {
        socket?.close();
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('disk-backed result and event rows retain command metadata', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-artifact-metadata-'));
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0'
    });
    let socket: WebSocket | undefined;
    let dispatchTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
        socket = await registerAgent(server.baseUrl, 'metadata-run', 'agent-a');
        const dispatched = Promise.withResolvers<MessageEvent>();
        dispatchTimeout = setTimeout(() => dispatched.reject(new Error('Queued metadata command was not dispatched.')), 5_000);
        socket.addEventListener('message', (event) => {
            clearTimeout(dispatchTimeout);
            dispatched.resolve(event);
        }, { once: true });
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
        expect(commandResponse.status).toEqual(202);

        const command = parseControlServerMessage((await dispatched.promise).data, {
            runId: 'metadata-run',
            agentId: 'agent-a'
        });
        assert(command.ok && command.envelope.kind === 'command');
        expect(command.envelope.commandId).toEqual('rtc-send-1');
        expect(command.envelope.command.kind).toEqual('rtc.send');
        const startedAtEpochMs = Date.now();
        const endedAtEpochMs = Date.now();
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
                startedAtEpochMs,
                endedAtEpochMs,
                durationMs: endedAtEpochMs - startedAtEpochMs,
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
        expect(resultRow.action).toEqual('rtc.send');
        expect(resultRow.transport).toEqual('messages.rtc');
        expect(resultRow.connection).toEqual('rtc-connection-1');

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
        expect(stepResult.action).toEqual('rtc.send');
        expect(stepResult.transport).toEqual('messages.rtc');
        const snapshot = await getJson<{
            commands: readonly object[];
            results: readonly object[];
            events: readonly object[];
            agents: readonly { agentId: string; completedCommandIds: readonly string[]; }[];
        }>(server.baseUrl, '/runs/metadata-run');
        expect(snapshot.commands.length).toEqual(0);
        expect(snapshot.results.length).toEqual(0);
        expect(snapshot.events.length).toEqual(0);
        expect(snapshot.agents.find((agent) => agent.agentId === 'agent-a')?.completedCommandIds).toEqual(['rtc-send-1']);
    }
    finally {
        clearTimeout(dispatchTimeout);
        socket?.close();
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('artifact JSONL responses wait for queued writes', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-artifact-flush-'));
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
        expect(seedResponse.status).toEqual(202);
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
            expect(response.status).toEqual(202);
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
        expect(targetResponse.status).toEqual(202);

        const jsonlResponse = await fetch(
            `${server.baseUrl}/runs/flush-run/events.jsonl`
        );
        expect(jsonlResponse.status).toEqual(200);
        assert((await jsonlResponse.text()).includes(targetMarker));
    }
    finally {
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('final report artifact rows dedupe across WebSocket and HTTP ingress', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-artifact-dedupe-'));
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
        expect(uploadResponse.status).toEqual(202);

        const eventsResponse = await fetch(
            `${server.baseUrl}/runs/dedupe-run/events.jsonl`
        );
        expect(eventsResponse.status).toEqual(200);
        const reportRows = (await eventsResponse.text())
            .trim()
            .split(/\r?\n/g)
            .filter((line) => line.includes('final-report-duplicate'));
        expect(reportRows.length).toEqual(1);
    }
    finally {
        socket?.close();
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('run artifact directories stay disk-address distinct for colliding run ids over HTTP', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-artifact-directory-'));
    // Retention is zero so the in-memory snapshot fallback is empty and events.jsonl responses
    // can only come from the on-disk run directory, proving the directory codec rather than
    // the runtime fallback.
    const server = await startControlServer({
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir,
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: '0',
        RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: '0'
    });
    try {
        const percentRunId = '%';
        const underscoreRunId = '_25';
        await postReport(server.baseUrl, percentRunId, 'percent-marker');
        await postReport(server.baseUrl, underscoreRunId, 'underscore-marker');

        const percentEvents = await waitForJsonl(
            server.baseUrl,
            `/runs/${encodeURIComponent(percentRunId)}/events.jsonl`,
            'percent-marker'
        );
        assert(!percentEvents.includes('underscore-marker'));

        const underscoreEvents = await waitForJsonl(
            server.baseUrl,
            `/runs/${encodeURIComponent(underscoreRunId)}/events.jsonl`,
            'underscore-marker'
        );
        assert(!underscoreEvents.includes('percent-marker'));
    }
    finally {
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

async function postReport(baseUrl: string, runId: string, marker: string): Promise<void> {
    const response = await fetch(
        `${baseUrl}/runs/${encodeURIComponent(runId)}/agents/agent-a/report`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reportEnvelope({
                runId,
                agentId: 'agent-a',
                eventId: `report-${marker}`,
                marker
            }))
        }
    );
    expect(response.status).toEqual(202);
}
