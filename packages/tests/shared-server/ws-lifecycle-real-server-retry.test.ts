import { describe, expect, it, vi } from 'vitest';

import { initWsLifecycle } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { toKeyAsString, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer, type ConnectionContext } from '@shared/websocket/JsonWebSocketServer.ts';

describe('real websocket close lifecycle retry ownership', () => {
    it('ignores an old in-flight failure after a newer generation succeeds', async () => {
        const server = new JsonWebSocketServer();
        const oldSocket = new CloseSocket();
        const newSocket = new CloseSocket();
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        const oldFailure = deferred<void>();
        const oldStarted = deferred<void>();
        const trusted = new Set(['session-1:generation-old', 'session-1:generation-new']);
        const scheduled: Array<() => Promise<void>> = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
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
                'session-1',
                oldSocket as never,
                'generation-old',
                1_000
            ));
            oldSocket.dispatchClose();
            await oldStarted.promise;

            server.addConnection(server.createConnectionContext(
                'session-1',
                newSocket as never,
                'generation-new',
                1_001
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
            'session-1',
            socket as never,
            'generation-1',
            1_000
        );
        const durableRows = new InMemoryQueueBox(new Map());
        const service = new WsQueueBoxServerService(
            durableRows,
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        const trusted = new Set([closeKey(connection)]);
        const scheduled: Array<() => Promise<void>> = [];
        let clientAttempts = 0;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
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
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
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
            'session-1',
            oldSocket as never,
            'generation-old',
            1_000
        ));

        server.addConnection(server.createConnectionContext(
            'session-1',
            newSocket as never,
            'generation-new',
            1_001
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

class CloseSocket {
    readyState: number = WebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(event: Event) => void>>();

    addEventListener(type: string, listener: (event: Event) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchClose();
    }

    send(_data: string): void {
    }

    dispatchClose(): void {
        const event = { code: 1000, reason: 'closed' } as CloseEvent;
        for (const listener of this.listeners.get('close') ?? []) {
            listener(event);
        }
    }
}

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
