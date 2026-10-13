import { describe, expect, it, vi } from 'vitest';

import { RallarBlackBoxControlClient } from '../../../shared-test/rallar-bb-test/control-client.ts';
import { parseControlClientMessage } from '../../../shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestEvent, RallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { FakeControlSocket } from './fake-control-socket.ts';

function createClient(runtime: RallarBlackBoxTestRuntime, socket: FakeControlSocket): RallarBlackBoxControlClient {
    return new RallarBlackBoxControlClient({
        runtime,
        now: Date.now,
        webSocketFactory: () => socket,
        fetch: () => Promise.reject(new Error('No upload configured.')),
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 0,
        reconnectBaseMs: 60_000,
        reconnectMaxMs: 60_000
    });
}

function connect(client: RallarBlackBoxControlClient, socket: FakeControlSocket, runId = 'run'): void {
    client.connect({ url: 'ws://control.test', runId, agentId: 'agent', completedCommandIds: [] });
    socket.open();
}

interface CapturedRuntimeEvent {
    readonly runId: string;
    readonly payload: RallarBlackBoxTestEvent;
}

function toRuntimeEvents(socket: FakeControlSocket): readonly CapturedRuntimeEvent[] {
    return socket.sent.flatMap((message) => {
        const parsed = parseControlClientMessage(message);
        if (!parsed.ok) {
            throw new Error(parsed.error);
        }
        const envelope = parsed.envelope;
        const payload = 'payload' in envelope ? envelope.payload : undefined;
        if (
            typeof payload !== 'object' || payload === null || !('history' in payload) || !('topic' in payload) || !('kind' in payload) ||
            !('eventId' in payload) || !('atEpochMs' in payload)
        ) {
            return [];
        }
        return [{ runId: envelope.runId, payload: payload as RallarBlackBoxTestEvent }];
    });
}

describe('black-box recent history capture', () => {
    it('publishes every redacted event once in ordinal order through reentrant subscribers', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        const unsubscribe = runtime.subscribe((state) => {
            if (state.events.at(-1)?.topic === 'outer') {
                for (let index = 0; index < 5; index++) {
                    runtime.recordEvent({ kind: 'message', topic: `nested.${index}`, payload: { accessToken: 'secret' } });
                }
            }
        });
        const socket = new FakeControlSocket();
        const client = createClient(runtime, socket);
        try {
            connect(client, socket);
            runtime.recordEvent({ kind: 'message', topic: 'outer' });
            const events = toRuntimeEvents(socket);
            expect(events.map((envelope) => envelope.payload.topic)).toEqual(['outer', 'nested.0', 'nested.1', 'nested.2', 'nested.3', 'nested.4']);
            expect(events.map((envelope) => envelope.payload.history)).toMatchObject([
                { generation: 0, ordinal: 1 },
                { generation: 0, ordinal: 2 },
                { generation: 0, ordinal: 3 },
                { generation: 0, ordinal: 4 },
                { generation: 0, ordinal: 5 },
                { generation: 0, ordinal: 6 }
            ]);
            expect(events.at(-1)?.payload.payload).toEqual({ accessToken: '<redacted>' });
            expect(runtime.state().eventHistory.capture).toMatchObject({ status: 'continuous' });
            client.disconnect();
            const final = socket.sent.map((message) => parseControlClientMessage(message)).findLast((parsed) => parsed.ok && parsed.envelope.kind === 'report');
            expect(final).toMatchObject({ envelope: { payload: { payload: { summary: { events: 6 }, stats: { counters: { events: 6 } } } } } });
        }
        finally {
            client.dispose();
            unsubscribe();
        }
    });

    it('keeps an unsent eviction gap through reconnect and reset, and starts a fresh address honestly', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        const socket = new FakeControlSocket();
        const client = createClient(runtime, socket);
        try {
            connect(client, socket);
            socket.close();
            for (let index = 0; index < 5; index++) {
                runtime.recordEvent({ kind: 'event', topic: `offline.${index}` });
            }
            expect(runtime.state().eventHistory.capture).toMatchObject({ status: 'gap', reason: 'unsent-events-evicted' });
            connect(client, socket);
            await runtime.execute({ kind: 'reset', commandId: 'reset' });
            const health = await runtime.execute({ kind: 'health', commandId: 'health' });
            expect(health.value).toMatchObject({ eventHistory: { capture: { status: 'gap', reason: 'unsent-events-evicted' } } });
            connect(client, socket, 'fresh-run');
            expect(runtime.state().eventHistory.capture).toMatchObject({ status: 'continuous', identity: { runId: 'fresh-run' } });
            socket.publishMessage(
                JSON.stringify({
                    kind: 'command',
                    protocolVersion: 1,
                    runId: 'fresh-run',
                    agentId: 'agent',
                    commandId: 'fresh-config',
                    command: { kind: 'configure', config: {} }
                })
            );
            await vi.waitFor(() => expect(runtime.state().resultCache['fresh-config']).toBeDefined());
            runtime.recordEvent({ kind: 'event', topic: 'fresh' });
            const topics = toRuntimeEvents(socket).filter((event) => event.runId === 'fresh-run').map((event) => event.payload.topic);
            expect(topics).toContain('fresh');
            expect(topics.some((topic) => topic.startsWith('offline.'))).toBe(false);
        }
        finally {
            client.dispose();
        }
    });

    it('exposes a publication failure without erasing it on a later successful send', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        const socket = new FakeControlSocket();
        const client = createClient(runtime, socket);
        try {
            connect(client, socket);
            vi.spyOn(socket, 'send').mockImplementationOnce(() => {
                throw new Error('publication failed');
            });
            runtime.recordEvent({ kind: 'message', topic: 'lost' });
            runtime.recordEvent({ kind: 'message', topic: 'later' });
            expect(runtime.state().eventHistory.capture).toMatchObject({ status: 'gap', reason: 'event-publication-failed' });
            expect(toRuntimeEvents(socket).map((event) => event.payload.topic)).toEqual(['later']);
        }
        finally {
            client.dispose();
        }
    });

    it('does not count an old address publication against a reentrant new assignment', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        const socket = new FakeControlSocket();
        const client = createClient(runtime, socket);
        let reassign = false;
        const unsubscribe = client.subscribe(() => {
            if (reassign) {
                reassign = false;
                connect(client, socket, 'new-run');
            }
        });
        try {
            connect(client, socket);
            reassign = true;
            runtime.recordEvent({ kind: 'event', topic: 'old-publication' });
            client.disconnect();
            const final = socket.sent.map((message) => parseControlClientMessage(message)).findLast((parsed) => parsed.ok && parsed.envelope.kind === 'report');
            expect(final).toMatchObject({ envelope: { runId: 'new-run', payload: { payload: { summary: { events: 0 } } } } });
        }
        finally {
            client.dispose();
            unsubscribe();
        }
    });

    it('does not mark a new capture broken when an old send failure reassigns from its error snapshot', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 1 } });
        const socket = new FakeControlSocket();
        const client = createClient(runtime, socket);
        const unsubscribe = client.subscribe((snapshot) => {
            if (snapshot.lastError === 'old-send-failed') {
                connect(client, socket, 'new-run');
            }
        });
        try {
            connect(client, socket);
            vi.spyOn(socket, 'send').mockImplementationOnce(() => {
                throw new Error('old-send-failed');
            });
            runtime.recordEvent({ kind: 'message', topic: 'old' });
            expect(runtime.state().eventHistory.capture).toMatchObject({ status: 'continuous', identity: { runId: 'new-run' } });
        }
        finally {
            client.dispose();
            unsubscribe();
        }
    });
});
