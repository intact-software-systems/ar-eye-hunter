import { describe, expect, it } from 'vitest';
import type { DirectRallarFacade } from '../../../apps/rallar-black-box/src/diagnostics/direct-rallar-contracts.ts';
import {
    runDirectRallarGroupCreate,
    runDirectRallarGroupJoin,
    runDirectRallarStatusCheck,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe
} from '../../../apps/rallar-black-box/src/direct-rallar-operations.ts';
import type { RallarMessage, RallarMessageHandler, RallarMessageSendResult } from '../../../packages/shared-web/browser/rallar.ts';
import type { AuthSession } from '../../../packages/shared/api/api-config.ts';

const session: AuthSession = {
    clientId: 'alice-client',
    accessToken: 'secret-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + 60_000
};

interface TestWsPayload {
    readonly text: string;
}

describe('direct Rallar operations', () => {
    it('refuses direct operations when the provider is simulated', async () => {
        let loadCalled = false;

        const result = await runDirectRallarStatusCheck({
            providerMode: 'simulated',
            apiBaseUrl: 'https://api.example.invalid',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            actor: 'alice'
        }, async () => {
            loadCalled = true;
            throw new Error('should not load facade');
        });

        expect(loadCalled).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_DIRECT_BACKEND_REQUIRED');
        expect(result.events.map((event) => event.topic)).toEqual([
            'rallar.direct.status.started',
            'rallar.direct.status.failed'
        ]);
        expect(result.events.at(-1)?.severity).toBe('error');
    });

    it('rejects Rallar Server WS sends with non-user topic prefixes before loading the facade', async () => {
        let loadCalled = false;

        const result = await runDirectRallarWsSend(
            {
                providerMode: 'browser-rallar',
                apiBaseUrl: 'http://localhost:8080',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                roomId: 'bb-group',
                actor: 'alice',
                authSession: session
            },
            {
                scope: 'room',
                typeId: 'manual.message',
                topicId: 'manual.message',
                payload: {
                    text: 'hello'
                }
            },
            async () => {
                loadCalled = true;
                throw new Error('should not load facade');
            }
        );

        expect(loadCalled).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('must start with app. or room.');
        expect(result.events.at(-1)?.topic).toBe('rallar.direct.ws.send.failed');
    });

    it('rejects invalid direct room ids before loading the facade', async () => {
        let loadCalled = false;

        const result = await runDirectRallarGroupJoin(
            {
                providerMode: 'browser-rallar',
                apiBaseUrl: 'http://localhost:8080',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                roomId: 'bad room',
                actor: 'alice',
                authSession: session
            },
            async () => {
                loadCalled = true;
                throw new Error('should not load facade');
            }
        );

        expect(loadCalled).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('Room ID');
    });

    it('configures and starts the browser Rallar facade for direct status checks', async () => {
        const calls: string[] = [];
        const facade: DirectRallarFacade = {
            configure(config) {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            setDefaults(defaults) {
                calls.push(`defaults:${String(defaults?.applicationId)}`);
            },
            defaults() {
                return {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1'
                };
            },
            async start(options) {
                calls.push(`start:${String(options?.connect)}`);
                return {
                    session,
                    connected: true
                };
            },
            status() {
                return 'connected';
            },
            isConnected() {
                return true;
            },
            session() {
                return session;
            },
            auth: {
                restore() {
                    return session;
                }
            },
            rooms: {
                current() {
                    return toTestDouble<NonNullable<ReturnType<DirectRallarFacade['rooms']['current']>>>({
                        group: toTestDouble<NonNullable<ReturnType<DirectRallarFacade['rooms']['current']>>['group']>({
                            groupId: 'bb-group'
                        })
                    });
                },
                list() {
                    return [
                        toTestDouble<ReturnType<DirectRallarFacade['rooms']['list']>[number]>({
                            roomId: 'bb-group'
                        })
                    ];
                },
                async create() {
                    throw new Error('unused');
                },
                async join() {
                    throw new Error('unused');
                }
            },
            people: {
                list() {
                    return [
                        toTestDouble<ReturnType<DirectRallarFacade['people']['list']>[number]>({
                            principalId: 'alice-client'
                        })
                    ];
                }
            },
            messages: {
                ws: {
                    async send() {
                        throw new Error('unused');
                    },
                    onMessage() {
                        throw new Error('unused');
                    }
                }
            },
            ws: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['ws']['status']>>({
                        readyState: 'open'
                    });
                }
            },
            rtc: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['rtc']['status']>>({
                        readyPeerIds: ['bob-session']
                    });
                }
            }
        };

        const result = await runDirectRallarStatusCheck({
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'bb-group',
            actor: 'alice',
            authSession: session,
            timeoutMs: 5000
        }, async () => facade);

        expect(calls).toEqual([
            'configure:http://localhost:8080',
            'defaults:app-1',
            'start:true'
        ]);
        expect(result.status).toBe('completed');
        expect(result.value).toMatchObject({
            action: 'status.check',
            connected: true,
            connectStatus: 'connected',
            roomCount: 1,
            peopleCount: 1
        });
        expect(result.value?.session).toEqual({
            clientId: 'alice-client',
            username: 'alice',
            sessionId: 'alice-session',
            expiresAtEpochMs: session.expiresAtEpochMs
        });
        expect(JSON.stringify(result.value)).not.toContain('secret-token');
        expect(result.events.map((event) => event.topic)).toEqual([
            'rallar.direct.status.started',
            'rallar.direct.status.completed'
        ]);
    });

    it('creates and joins a group through the browser Rallar facade', async () => {
        const calls: string[] = [];
        const facade: DirectRallarFacade = {
            configure(config) {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            setDefaults(defaults) {
                calls.push(`defaults:${String(defaults?.applicationId)}`);
            },
            defaults() {
                return undefined;
            },
            async start() {
                calls.push('start');
                return {
                    session,
                    connected: true
                };
            },
            status() {
                return 'connected';
            },
            isConnected() {
                return true;
            },
            session() {
                return session;
            },
            auth: {
                restore() {
                    return session;
                }
            },
            rooms: {
                current() {
                    return undefined;
                },
                list() {
                    return [];
                },
                async create(input) {
                    const groupId = typeof input === 'string' ? input : input.groupId ?? input.displayName;
                    const displayName = typeof input === 'string' ? input : input.displayName;
                    calls.push(`create:${groupId}:${displayName}`);
                    return toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['create']>>>({
                        group: toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['create']>>['group']>({
                            groupId,
                            displayName
                        })
                    });
                },
                async join(room) {
                    const roomId = typeof room === 'string'
                        ? room
                        : 'groupId' in room
                        ? room.groupId
                        : room.roomId ?? 'missing-room';
                    calls.push(`join:${roomId}`);
                    return toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['join']>>>({
                        group: toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['join']>>['group']>({
                            groupId: roomId
                        })
                    });
                }
            },
            people: {
                list() {
                    return [];
                }
            },
            messages: {
                ws: {
                    async send() {
                        throw new Error('unused');
                    },
                    onMessage() {
                        throw new Error('unused');
                    }
                }
            },
            ws: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['ws']['status']>>({
                        readyState: 'open'
                    });
                }
            },
            rtc: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['rtc']['status']>>({});
                }
            }
        };

        const createResult = await runDirectRallarGroupCreate({
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'bb-group',
            actor: 'alice',
            authSession: session,
            timeoutMs: 5000
        }, async () => facade);

        const joinResult = await runDirectRallarGroupJoin({
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'created-group-id',
            actor: 'alice',
            authSession: session,
            timeoutMs: 5000
        }, async () => facade);

        expect(calls).toEqual([
            'configure:http://localhost:8080',
            'defaults:app-1',
            'start',
            'create:bb-group:bb-group',
            'configure:http://localhost:8080',
            'defaults:app-1',
            'start',
            'join:created-group-id'
        ]);
        expect(createResult.status).toBe('completed');
        expect(createResult.value?.groupId).toBe('bb-group');
        expect(joinResult.status).toBe('completed');
        expect(joinResult.value?.groupId).toBe('created-group-id');
    });

    it('subscribes and sends WS messages through direct Rallar operations', async () => {
        const calls: string[] = [];
        let subscribedHandler: RallarMessageHandler<TestWsPayload> | undefined;
        const facade: DirectRallarFacade = {
            configure(config) {
                calls.push(`configure:${config.apiBaseUrl}`);
            },
            setDefaults(defaults) {
                calls.push(`defaults:${String(defaults?.applicationId)}`);
            },
            defaults() {
                return undefined;
            },
            async start() {
                calls.push('start');
                return {
                    session,
                    connected: true
                };
            },
            status() {
                return 'connected';
            },
            isConnected() {
                return true;
            },
            session() {
                return session;
            },
            auth: {
                restore() {
                    return session;
                }
            },
            rooms: {
                current() {
                    return undefined;
                },
                list() {
                    return [];
                },
                async create() {
                    throw new Error('unused');
                },
                async join(room) {
                    const roomId = typeof room === 'string'
                        ? room
                        : 'groupId' in room
                        ? room.groupId
                        : room.roomId ?? 'missing-room';
                    calls.push(`join:${roomId}`);
                    return toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['join']>>>({
                        group: toTestDouble<Awaited<ReturnType<DirectRallarFacade['rooms']['join']>>['group']>({
                            groupId: roomId
                        })
                    });
                }
            },
            people: {
                list() {
                    return [];
                }
            },
            messages: {
                ws: {
                    async send(input) {
                        calls.push(`send:${String(input.roomId)}:${String(input.typeId)}`);
                        return toTestDouble<RallarMessageSendResult>({
                            status: 'enqueued'
                        });
                    },
                    onMessage(selector, handler) {
                        const selectorLabel = typeof selector === 'string'
                            ? selector
                            : `${String(selector.topicId)}:${String(selector.typeId)}`;
                        calls.push(`subscribe:${selectorLabel}`);
                        subscribedHandler = toTestWsMessageHandler(handler);
                        return () => calls.push('unsubscribe');
                    }
                }
            },
            ws: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['ws']['status']>>({
                        readyState: 'open'
                    });
                }
            },
            rtc: {
                status() {
                    return toTestDouble<ReturnType<DirectRallarFacade['rtc']['status']>>({});
                }
            }
        };
        const context = {
            providerMode: 'browser-rallar' as const,
            apiBaseUrl: 'http://localhost:8080',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            roomId: 'bb-group',
            actor: 'alice',
            authSession: session,
            timeoutMs: 5000
        };

        const received: RallarMessage<TestWsPayload>[] = [];
        const subscribeResult = await runDirectRallarWsSubscribe(
            context,
            {
                selector: { typeId: 'room.manual.message', topicId: 'room.manual.message' },
                handler: (message: RallarMessage<TestWsPayload>) => {
                    received.push(message);
                }
            },
            async () => facade
        );
        await subscribedHandler?.(toTestDouble<RallarMessage<TestWsPayload>>({
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            payload: {
                text: 'hello'
            }
        }));
        const sendResult = await runDirectRallarWsSend(
            context,
            {
                scope: 'room',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                contextId: 'bb-group',
                payload: {
                    text: 'hello'
                }
            },
            async () => facade
        );
        subscribeResult.unsubscribe?.();

        expect(calls).toEqual([
            'configure:http://localhost:8080',
            'defaults:app-1',
            'subscribe:room.manual.message:room.manual.message',
            'start',
            'join:bb-group',
            'configure:http://localhost:8080',
            'defaults:app-1',
            'start',
            'send:bb-group:room.manual.message',
            'unsubscribe'
        ]);
        expect(subscribeResult.status).toBe('completed');
        expect(sendResult.status).toBe('completed');
        expect(received).toHaveLength(1);
        expect(sendResult.events.map((event) => event.topic)).toEqual([
            'rallar.direct.ws.send.started',
            'rallar.direct.ws.send.completed'
        ]);
        expect(sendResult.events.every((event) => event.transport === 'ws')).toBe(true);
    });
});

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}

function toTestWsMessageHandler<T>(
    handler: RallarMessageHandler<T>
): RallarMessageHandler<TestWsPayload> {
    return handler as object as RallarMessageHandler<TestWsPayload>;
}
