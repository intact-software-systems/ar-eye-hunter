import {
    parseControlServerMessage,
    type ControlClientIdentity,
    type ControlCommandEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { registerAgent, waitForJsonl, waitForSocketClose, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { getJson, startControlServer } from './support/control-api-test-server.ts';
import { toRegisterEnvelope } from './support/control-service-test-fixtures.ts';
import { executeControlRuntimeCommand } from './support/execute-control-runtime-command.ts';

Deno.test('the same socket cannot manufacture a later reload registration', async () => {
    const server = await startControlServer();
    const socket = await registerAgent(server.baseUrl, 'run-1', 'agent-1');
    try {
        const closed = waitForSocketClose(socket);
        socket.send(JSON.stringify(toRegisterEnvelope({ completedCommandIds: ['reload-id'] })));
        assertEquals((await closed).code, 1008);
        const snapshot = await getJson<ControlRunSnapshot>(server.baseUrl, '/runs/run-1');
        assertEquals(snapshot.agents[0].connectionSequence, 1);
        assertEquals(snapshot.agents[0].resumeCompletedCommandIds, []);
    }
    finally {
        socket.close();
        await server.stop();
    }
});

Deno.test('socket result identity must match its registered run and agent', async () => {
    const server = await startControlServer();
    const socket = await registerAgent(server.baseUrl, 'run-1', 'agent-1');
    try {
        const closed = waitForSocketClose(socket);
        socket.send(JSON.stringify({ kind: 'result', protocolVersion: 1, runId: 'run-1', agentId: 'agent-2', commandId: 'foreign', ok: true }));
        assertEquals((await closed).code, 1008);
        const snapshot = await getJson<ControlRunSnapshot>(server.baseUrl, '/runs/run-1');
        assertEquals(snapshot.results, []);
    }
    finally {
        socket.close();
        await server.stop();
    }
});

Deno.test('an unregistered socket cannot inject a reload result', async () => {
    const server = await startControlServer();
    const socket = new WebSocket(server.baseUrl.replace('http:', 'ws:') + '/control');
    try {
        await waitForSocketOpen(socket);
        const closed = waitForSocketClose(socket);
        socket.send(JSON.stringify({ kind: 'result', protocolVersion: 1, runId: 'run-1', agentId: 'agent-1', commandId: 'foreign', ok: true }));
        assertEquals((await closed).code, 1008);
    }
    finally {
        socket.close();
        await server.stop();
    }
});

Deno.test('a new registered socket resumes the actual reload and receives only the suffix', async () => {
    const server = await startControlServer();
    const original = await registerAgent(server.baseUrl, 'run-1', 'agent-1');
    let replacement: WebSocket | undefined;
    try {
        const prefixArrives = nextSocketCommand(original, { runId: 'run-1', agentId: 'agent-1' });
        const response = await fetch(server.baseUrl + '/runs/run-1/agents/agent-1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                commandId: 'socket-root',
                command: {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'socket-reload',
                        continueOnFailure: false,
                        metadata: { profile: 'alm-conformance' },
                        commands: [{ kind: 'health', commandId: 'before' }, { kind: 'agent.reload', commandId: 'reload', readyTimeoutMs: 1_000 }, {
                            kind: 'health',
                            commandId: 'after'
                        }]
                    }
                }
            })
        });
        assertEquals(response.status, 202);
        await response.json();
        const prefix = await prefixArrives;
        const forgedRoot = await executeSocketCommand({ ...prefix, commandId: 'socket-root' });
        original.send(JSON.stringify(forgedRoot));
        const reloadArrives = nextSocketCommand(original, { runId: 'run-1', agentId: 'agent-1' });
        original.send(JSON.stringify(await executeSocketCommand(prefix)));
        const reload = await reloadArrives;
        assertEquals(reload.command.kind, 'agent.reload');
        original.send(JSON.stringify(await executeSocketCommand(reload)));
        replacement = new WebSocket(server.baseUrl.replace('http:', 'ws:') + '/control');
        await waitForSocketOpen(replacement);
        const suffixArrives = nextSocketCommand(replacement, { runId: 'run-1', agentId: 'agent-1' });
        replacement.send(JSON.stringify(toRegisterEnvelope({ completedCommandIds: [reload.commandId] })));
        const suffix = await suffixArrives;
        assertEquals(suffix.command.kind, 'recipe.run');
        if (suffix.command.kind === 'recipe.run') {
            assertEquals(suffix.command.recipe?.commands.map((child) => child.commandId), ['before', 'reload', 'after']);
            assertEquals(suffix.recipeExecution?.segment, { start: 2, end: 3, first: false });
        }
        replacement.send(JSON.stringify(await executeSocketCommand(suffix)));
        const recorded = await waitForJsonl(server.baseUrl, '/runs/run-1/results.jsonl', JSON.stringify(suffix.commandId));
        assertEquals(
            recorded.split('\n').filter(Boolean).some((line) => {
                const row = decodeRecord(JSON.parse(line));
                assert(typeof row.commandId === 'string', 'journal result row requires its command identity');
                return row.commandId === 'socket-root';
            }),
            false
        );
    }
    finally {
        original.close();
        replacement?.close();
        await server.stop();
    }
});

function nextSocketCommand(socket: WebSocket, identity: ControlClientIdentity): Promise<ControlCommandEnvelope> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Expected next reload command.')), 2_000);
        socket.addEventListener('message', (event) => {
            clearTimeout(timeout);
            const parsed = parseControlServerMessage(String(event.data), identity);
            if (!parsed.ok) {
                reject(new Error(parsed.error));
                return;
            }
            resolve(parsed.envelope);
        }, { once: true });
    });
}

async function executeSocketCommand(command: ControlCommandEnvelope): Promise<ControlResultEnvelope> {
    const result = command.command.kind === 'agent.reload'
        ? toAgentReloadResult({ commandId: command.commandId, readyTimeoutMs: command.command.readyTimeoutMs, written: 'written', atEpochMs: Date.now() })
        : await executeControlRuntimeCommand(createDefaultRallarBlackBoxTestRuntime(), command);
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: command.runId,
        agentId: command.agentId!,
        commandId: command.commandId,
        ok: result.ok,
        result
    };
}

Deno.test('NUL-containing run and agent identities keep distinct socket ownership and dispatch', async () => {
    const server = await startControlServer();
    const first = await registerAgent(server.baseUrl, 'a', 'b\u0000c');
    const second = await registerAgent(server.baseUrl, 'a\u0000b', 'c');
    try {
        assertEquals(first.readyState, WebSocket.OPEN);
        const commandArrives = nextSocketCommand(first, { runId: 'a', agentId: 'b\u0000c' });
        const response = await fetch(server.baseUrl + '/runs/a/agents/b%00c/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commandId: 'first-only', command: { kind: 'health' } })
        });
        assertEquals(response.status, 202);
        await response.json();
        const command = await commandArrives;
        assertEquals([command.runId, command.agentId, command.commandId], ['a', 'b\u0000c', 'first-only']);
        const closed = waitForSocketClose(first);
        const deletion = await fetch(server.baseUrl + '/runs/a', { method: 'DELETE' });
        await deletion.text();
        await closed;
        assertEquals(second.readyState, WebSocket.OPEN);
        const nextCommandArrives = nextSocketCommand(second, { runId: 'a\u0000b', agentId: 'c' });
        const nextResponse = await fetch(server.baseUrl + '/runs/a%00b/agents/c/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commandId: 'second-only', command: { kind: 'health' } })
        });
        assertEquals(nextResponse.status, 202);
        await nextResponse.json();
        assertEquals((await nextCommandArrives).commandId, 'second-only');
    }
    finally {
        first.close();
        second.close();
        await server.stop();
    }
});
