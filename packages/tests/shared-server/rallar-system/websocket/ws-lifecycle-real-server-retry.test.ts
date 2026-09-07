import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { initWsLifecycle } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toKeyAsString, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer, type ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

describe('real websocket close lifecycle retry ownership', () => {
    it('ignores an old in-flight failure after a newer generation succeeds', async () => {
        const server = new JsonWebSocketServer();
        const oldSocket = new CloseSocket();
        const newSocket = new CloseSocket();
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        });
        const oldFailure = Promise.withResolvers<void>();
        const oldStarted = Promise.withResolvers<void>();
        const trusted = new Set(['session-1:generation-old', 'session-1:generation-new']);
        const scheduled: Array<() => Promise<void>> = [];
        const unhandled: Error[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(toError(reason));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        process.on('unhandledRejection', onUnhandled);

        try {
            const runtime = initWsLifecycle(service, {
                now: () => 1_100,
                enqueueClientSessionDisconnect: async (input) => {
                    if (input.generationId === 'generation-old') {
                        oldStarted.resolve();
                        await oldFailure.promise;
                    }
                },
                enqueueGroupSessionCleanup: () => Promise.resolve(),
                hasCloseFacts: (input) => trusted.has(closeKey(input)),
                releaseCloseFacts: (input) => trusted.delete(closeKey(input)),
                retry: {
                    delaysMs: [1, 2, 4],
                    schedule: (_delayMs, retry) => {
                        scheduled.push(retry);
                        return () => {
                            const index = scheduled.indexOf(retry);
                            if (index >= 0) {
                                scheduled.splice(index, 1);
                            }
                        };
                    }
                }
            });
            server.addConnection(server.createConnectionContext(
                { id: 'session-1', socket: oldSocket, generationId: 'generation-old', observedAtEpochMs: 1_000 }
            ));
            oldSocket.dispatchClose();
            await oldStarted.promise;

            server.addConnection(server.createConnectionContext(
                { id: 'session-1', socket: newSocket, generationId: 'generation-new', observedAtEpochMs: 1_001 }
            ));
            newSocket.dispatchClose();
            await flushAsyncEvents();
            oldFailure.reject(new Error('late old failure'));
            await flushAsyncEvents();

            expect(unhandled).toEqual([]);
            expect(runtime.getPendingCloseCount()).toBe(0);
            expect(scheduled).toEqual([]);
            expect(trusted).toEqual(new Set());
            runtime.stop();
        }
        finally {
            process.off('unhandledRejection', onUnhandled);
            consoleError.mockRestore();
        }
    });

    it('retains trusted facts after storage failure and retries without an unhandled rejection', async () => {
        const server = new JsonWebSocketServer();
        const socket = new CloseSocket();
        const connection = server.createConnectionContext(
            { id: 'session-1', socket: socket, generationId: 'generation-1', observedAtEpochMs: 1_000 }
        );
        const durableRows = new InMemoryQueueBox(new Map());
        const service = createDefaultWsQueueBoxServerService({
            inbox: durableRows,
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        });
        const trusted = new Set([closeKey(connection)]);
        const scheduled: Array<() => Promise<void>> = [];
        let clientAttempts = 0;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unhandled: Error[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(toError(reason));
        process.on('unhandledRejection', onUnhandled);

        try {
            const runtime = initWsLifecycle(service, {
                now: () => 1_001,
                enqueueClientSessionDisconnect: (input) => {
                    expect(trusted.has(closeKey(input))).toBe(true);
                    clientAttempts += 1;
                    if (clientAttempts === 1) {
                        return Promise.reject(new Error('storage unavailable'));
                    }
                    return writeDurableRow(durableRows, 'client', input);
                },
                enqueueGroupSessionCleanup: (input) => {
                    expect(trusted.has(closeKey(input))).toBe(true);
                    return writeDurableRow(durableRows, 'group', input);
                },
                hasCloseFacts: (input) => trusted.has(closeKey(input)),
                releaseCloseFacts: (input) => {
                    trusted.delete(closeKey(input));
                },
                retry: {
                    delaysMs: [1, 2, 4],
                    schedule: (_delayMs: number, retry: () => Promise<void>) => {
                        scheduled.push(retry);
                        return () => undefined;
                    }
                }
            });
            server.addConnection(connection);

            socket.dispatchClose();
            await flushAsyncEvents();

            expect(unhandled).toEqual([]);
            expect(runtime.getPendingCloseCount()).toBe(1);
            expect(trusted).toEqual(new Set(['session-1:generation-1']));
            expect(scheduled).toHaveLength(1);
            expect(new Set((await durableRows.getAllKeys()).map(toKeyAsString))).toEqual(
                new Set(['APP_INBOX/group:session-1:generation-1/session-1'])
            );

            await scheduled.shift()?.();
            await flushAsyncEvents();

            expect(new Set((await durableRows.getAllKeys()).map(toKeyAsString))).toEqual(
                new Set([
                    'APP_INBOX/group:session-1:generation-1/session-1',
                    'APP_INBOX/client:session-1:generation-1/session-1'
                ])
            );
            expect(trusted).toEqual(new Set());
            expect(runtime.getPendingCloseCount()).toBe(0);
            runtime.stop();
        }
        finally {
            process.off('unhandledRejection', onUnhandled);
            consoleError.mockRestore();
        }
    });

    it('runs lifecycle cleanup for a connection replaced by a newer generation', async () => {
        const server = new JsonWebSocketServer();
        const oldSocket = new CloseSocket();
        const newSocket = new CloseSocket();
        const closed: string[] = [];
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        });
        initWsLifecycle(service, {
            now: () => 1_100,
            enqueueClientSessionDisconnect: (input) => {
                closed.push(`client:${input.generationId}`);
                return Promise.resolve();
            },
            enqueueGroupSessionCleanup: (input) => {
                closed.push(`group:${input.generationId}`);
                return Promise.resolve();
            },
            hasCloseFacts: () => true,
            releaseCloseFacts: () => undefined,
            retry: {
                delaysMs: [1],
                schedule: () => () => undefined
            }
        });
        server.addConnection(server.createConnectionContext(
            { id: 'session-1', socket: oldSocket, generationId: 'generation-old', observedAtEpochMs: 1_000 }
        ));

        server.addConnection(server.createConnectionContext(
            { id: 'session-1', socket: newSocket, generationId: 'generation-new', observedAtEpochMs: 1_001 }
        ));
        await flushAsyncEvents();

        expect(closed).toEqual(['client:generation-old', 'group:generation-old']);
    });
});

function closeKey(
    input: Pick<ConnectionContext, 'id' | 'generationId'> | {
        sessionId: string;
        generationId: string;
    }
): string {
    const sessionId = 'id' in input ? input.id : input.sessionId;
    return `${sessionId}:${input.generationId}`;
}

async function writeDurableRow(
    queue: InMemoryQueueBox,
    kind: 'client' | 'group',
    input: {
        readonly sessionId: string;
        readonly generationId: string;
    }
): Promise<void> {
    await queue.enqueue(toResourceEntryWithKey(
        {
            topicId: 'APP_INBOX',
            resourceId: `${kind}:${closeKey(input)}`,
            contextId: input.sessionId
        },
        'APP_INBOX',
        { kind, ...input }
    ));
}

async function flushAsyncEvents(): Promise<void> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

class CloseSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly url = 'ws://close-lifecycle-test';
    binaryType: BinaryType = 'blob';
    readyState: WebSocket['readyState'] = WebSocket.OPEN;
    onclose: WebSocket['onclose'] = null;
    onerror: WebSocket['onerror'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onopen: WebSocket['onopen'] = null;

    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchClose();
    }

    send(): void {}

    dispatchClose(): void {
        this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'closed' }));
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
