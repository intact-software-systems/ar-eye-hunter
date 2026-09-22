import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { assertEquals } from '@std/assert';

import { registerAgent, waitForJsonl, waitForSocketClose, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { getJson, startControlServer } from './support/control-api-test-server.ts';
import { toRegisterEnvelope } from './support/control-service-test-fixtures.ts';

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
        const prefixArrives = nextSocketCommand(original);
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
        const forgedRoot = socketCommandResult({ ...prefix, commandId: 'socket-root' });
        original.send(JSON.stringify(forgedRoot));
        const reloadArrives = nextSocketCommand(original);
        original.send(JSON.stringify(socketCommandResult(prefix)));
        const reload = await reloadArrives;
        assertEquals(reload.command.kind, 'agent.reload');
        original.send(JSON.stringify(socketCommandResult(reload)));
        replacement = new WebSocket(server.baseUrl.replace('http:', 'ws:') + '/control');
        await waitForSocketOpen(replacement);
        const suffixArrives = nextSocketCommand(replacement);
        replacement.send(JSON.stringify(toRegisterEnvelope({ completedCommandIds: [reload.commandId] })));
        const suffix = await suffixArrives;
        assertEquals(suffix.command.kind, 'recipe.run');
        if (suffix.command.kind === 'recipe.run') {
            assertEquals(suffix.command.recipe?.commands, [{ kind: 'health', commandId: 'after' }]);
        }
        replacement.send(JSON.stringify(socketCommandResult(suffix)));
        const recorded = await waitForJsonl(server.baseUrl, '/runs/run-1/results.jsonl', JSON.stringify(suffix.commandId));
        assertEquals(recorded.split('\n').filter(Boolean).some((line) => JSON.parse(line).commandId === 'socket-root'), false);
    }
    finally {
        original.close();
        replacement?.close();
        await server.stop();
    }
});

function nextSocketCommand(socket: WebSocket): Promise<ControlCommandEnvelope> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Expected next reload command.')), 2_000);
        socket.addEventListener('message', (event) => {
            clearTimeout(timeout);
            resolve(JSON.parse(String(event.data)));
        }, { once: true });
    });
}

function socketCommandResult(command: ControlCommandEnvelope): ControlResultEnvelope {
    const timestamp = Date.now();
    const result = {
        commandId: command.commandId,
        kind: command.command.kind,
        status: 'ok' as const,
        ok: true,
        startedAtEpochMs: timestamp,
        endedAtEpochMs: timestamp,
        durationMs: 0
    };
    const value = command.command.kind === 'recipe.run'
        ? {
            recipeId: command.command.recipe!.recipeId,
            results: command.command.recipe!.commands.map((child) => ({ ...result, commandId: child.commandId, kind: child.kind }))
        }
        : { reloading: true };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: command.runId,
        agentId: command.agentId!,
        commandId: command.commandId,
        ok: true,
        result: { ...result, value }
    };
}

Deno.test('NUL-containing run and agent identities keep distinct socket ownership and dispatch', async () => {
    const server = await startControlServer();
    const first = await registerAgent(server.baseUrl, 'a', 'b\u0000c');
    const second = await registerAgent(server.baseUrl, 'a\u0000b', 'c');
    try {
        assertEquals(first.readyState, WebSocket.OPEN);
        const commandArrives = nextSocketCommand(first);
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
        const nextCommandArrives = nextSocketCommand(second);
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
