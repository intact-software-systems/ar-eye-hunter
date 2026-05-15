// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/types.ts';
import { RallarBlackBoxControlClient } from '../../../apps/rallar-black-box/src/control-client.ts';
import {
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlResultEnvelope,
    parseControlServerMessage,
} from '../../../apps/rallar-black-box/src/control-protocol.ts';

type Listener = (event: unknown) => void;

class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Set<Listener>>();

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.emit('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }

    message(data: unknown): void {
        this.emit('message', { data });
    }

    private emit(type: string, event: unknown): void {
        this.listeners.get(type)?.forEach(listener => listener(event));
    }
}

function envelopes(socket: FakeControlSocket): ControlClientEnvelope[] {
    return socket.sent.map(serialized => JSON.parse(serialized) as ControlClientEnvelope);
}

function resultsFor(socket: FakeControlSocket, commandId: string): ControlResultEnvelope[] {
    return envelopes(socket)
        .filter((envelope): envelope is ControlResultEnvelope =>
            envelope.kind === 'result' &&
            envelope.commandId === commandId
        );
}

function commandEnvelope(
    commandId: string,
    command: RallarBlackBoxTestCommand,
): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command,
    };
}

function configureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice',
        },
    };
}

describe('rallar-black-box control client', () => {
    it('validates control command envelopes', () => {
        const valid = parseControlServerMessage(
            JSON.stringify(commandEnvelope('configure-1', configureCommand())),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(valid.ok).toBe(true);
        expect(valid.ok ? valid.envelope.commandId : '').toBe('configure-1');

        const mismatchedRun = parseControlServerMessage(
            JSON.stringify({
                ...commandEnvelope('configure-1', configureCommand()),
                runId: 'other-run',
            }),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(mismatchedRun).toEqual({
            ok: false,
            error: 'Control command runId does not match this agent.',
        });

        const unsupportedCommand = parseControlServerMessage(
            JSON.stringify({
                ...commandEnvelope('unknown-1', configureCommand()),
                command: {
                    kind: 'script.eval',
                },
            }),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(unsupportedCommand).toEqual({
            ok: false,
            error: 'Control command payload is invalid.',
        });
    });

    it('registers, dispatches commands, and streams results and events', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            webSocketFactory: () => socket,
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();

            expect(envelopes(socket)[0]).toMatchObject({
                kind: 'register',
                runId: 'run-1',
                agentId: 'agent-1',
            });

            socket.message(JSON.stringify(commandEnvelope('configure-1', configureCommand())));

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(1);
            });

            expect(resultsFor(socket, 'configure-1')[0]).toMatchObject({
                kind: 'result',
                commandId: 'configure-1',
                ok: true,
                replayed: false,
            });
            expect(envelopes(socket).some(envelope =>
                envelope.kind === 'diagnostic' &&
                envelope.commandId === 'configure-1'
            )).toBe(true);
            expect(client.currentSnapshot()).toMatchObject({
                state: 'registered',
                receivedCount: 1,
            });
        } finally {
            client.dispose();
        }
    });

    it('replays cached command results for duplicate command IDs', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            webSocketFactory: () => socket,
        });
        const command = JSON.stringify(commandEnvelope('configure-1', configureCommand()));

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();
            socket.message(command);

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(1);
            });

            socket.message(command);

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(2);
            });

            const results = resultsFor(socket, 'configure-1');
            expect(results[0].replayed).toBe(false);
            expect(results[1].replayed).toBe(true);
            expect(runtime.state().commandHistory
                .filter(result => result.commandId === 'configure-1')).toHaveLength(1);
        } finally {
            client.dispose();
        }
    });

    it('resumes after reconnect and replays completed results', async () => {
        vi.useFakeTimers();

        const sockets: FakeControlSocket[] = [];
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            reconnectBaseMs: 25,
            reconnectMaxMs: 25,
            webSocketFactory: () => {
                const socket = new FakeControlSocket();
                sockets.push(socket);
                return socket;
            },
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            sockets[0].open();
            sockets[0].message(JSON.stringify(commandEnvelope('configure-1', configureCommand())));

            await vi.waitFor(() => {
                expect(resultsFor(sockets[0], 'configure-1')).toHaveLength(1);
            });

            sockets[0].close();
            expect(client.currentSnapshot().state).toBe('reconnecting');

            await vi.advanceTimersByTimeAsync(25);
            expect(sockets).toHaveLength(2);

            sockets[1].open();

            await vi.waitFor(() => {
                expect(resultsFor(sockets[1], 'configure-1')).toHaveLength(1);
            });

            expect(envelopes(sockets[1])[0]).toMatchObject({
                kind: 'register',
                resume: {
                    completedCommandIds: ['configure-1'],
                },
            });
            expect(resultsFor(sockets[1], 'configure-1')[0].replayed).toBe(true);
        } finally {
            client.dispose();
            vi.useRealTimers();
        }
    });
});
