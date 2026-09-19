import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    runDirectRallarGroupCreate,
    runDirectRallarGroupJoin,
    runDirectRallarStatusCheck,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarFacade
} from '../../../apps/rallar-black-box/src/direct-rallar-operations.ts';
import type { RallarMessagePayload } from '../../../packages/shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessage, RallarMessageHandler } from '../../../packages/shared-web/browser/rallar.ts';
import type { AuthSession } from '../../../packages/shared/api/api-config.ts';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

const session: AuthSession = {
    clientId: 'alice-client',
    accessToken: 'secret-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + 60_000
};

describe('direct Rallar operations', () => {
    it('reports every invalid send field before loading the facade', async () => {
        const result = await runDirectRallarWsSend(
            {
                providerMode: 'browser-rallar',
                apiBaseUrl: 'http://localhost',
                applicationId: 'app',
                workspaceId: 'workspace',
                roomId: 'bad room'
            },
            { scope: 'room', typeId: '', topicId: 'invalid.topic', payload: undefined },
            async () => {
                throw new Error('Validation must precede facade loading');
            }
        );
        expect(result.status).toBe('failed');
        expect(result.error?.details).toMatchObject({
            issues: [
                expect.objectContaining({ path: '$.typeId' }),
                expect.objectContaining({ path: '$.topicId' }),
                expect.objectContaining({ path: '$.roomId' }),
                expect.objectContaining({ path: '$.payload' })
            ]
        });
    });

    it.each(['start', 'join'] as const)('releases the listener when %s rejects', async (failure) => {
        const unsubscribe = vi.fn();
        const facade = createDirectTestFacade({
            configure: () => {},
            setDefaults: () => {},
            session: () => session,
            start: async () => {
                if (failure === 'start') {
                    throw new Error('start failed');
                }
                return { session, connected: true };
            },
            rooms: {
                current: () => undefined,
                list: () => [],
                create: unsupportedOperation,
                ...{
                    join: async () => {
                        throw new Error('join failed');
                    }
                }
            },
            messages: { ws: { send: async () => createMessageDelivery('ws', undefined).handle, onMessage: () => unsubscribe } }
        });
        const result = await runDirectRallarWsSubscribe(
            {
                context: {
                    providerMode: 'browser-rallar',
                    apiBaseUrl: 'http://localhost',
                    applicationId: 'app',
                    workspaceId: 'workspace',
                    roomId: 'room',
                    authSession: session
                },
                selector: { topicId: 'room.test', typeId: 'test' },
                handler: () => {},
                readFacade: async () => facade
            }
        );
        expect(result.status).toBe('failed');
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(result.unsubscribe).toBeUndefined();
    });

    it('preserves a non-Error rejection as the existing error projection', async () => {
        const result = await runDirectRallarStatusCheck({
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost',
            applicationId: 'app',
            workspaceId: 'workspace'
        }, async () => Promise.reject('facade unavailable'));
        expect(result.error).toEqual({ code: 'RALLAR_DIRECT_OPERATION_FAILED', message: 'facade unavailable' });
    });

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

    it.each([
        ['undefined', undefined],
        ['function', () => undefined],
        ['symbol', Symbol('unsupported')],
        ['bigint', BigInt(1)]
    ])('rejects an unsupported %s WS payload before loading the facade', async (_label, payload) => {
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
                topicId: 'room.manual.message',
                payload
            },
            async () => {
                loadCalled = true;
                throw new Error('should not load facade');
            }
        );

        expect(loadCalled).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('object, array, string, number, boolean, or null');
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
                    return createGroupSnapshotFixture({
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'bb-group',
                        sessionIds: [session.sessionId]
                    });
                },
                list() {
                    return [
                        {
                            roomId: 'bb-group',
                            roomRef: snapshot.group,
                            name: 'bb-group',
                            status: snapshot.group.status,
                            kind: snapshot.group.kind,
                            joinMode: snapshot.group.joinMode,
                            memberCount: 1,
                            onlineMemberCount: 1,
                            isJoined: true,
                            isCurrent: true,
                            snapshot
                        }
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
                        {
                            principalId: 'alice-client',
                            username: 'alice',
                            isOnline: true,
                            activeSessionCount: 1,
                            activeSessionIds: [session.sessionId],
                            snapshot: createClientSnapshotFixture({ applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'alice-client' })
                        }
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
                    return createWsStatus();
                }
            },
            rtc: {
                status() {
                    return createRtcStatus({
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
                    return createGroupSnapshotFixture({
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: groupId ?? 'missing',
                        sessionIds: [session.sessionId]
                    });
                },
                async join(room) {
                    const roomId = typeof room === 'string'
                        ? room
                        : 'groupId' in room
                        ? room.groupId
                        : room.roomId ?? 'missing-room';
                    calls.push(`join:${roomId}`);
                    return createGroupSnapshotFixture({
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: roomId ?? 'missing',
                        sessionIds: [session.sessionId]
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
                    return createWsStatus();
                }
            },
            rtc: {
                status() {
                    return createRtcStatus({});
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
        expect(createResult.value).toMatchObject({ action: 'group.create', groupId: 'bb-group' });
        expect(joinResult.status).toBe('completed');
        expect(joinResult.value).toMatchObject({ action: 'group.join', groupId: 'created-group-id' });
    });

    it('subscribes and sends WS messages through direct Rallar operations', async () => {
        const calls: string[] = [];
        let subscribedHandler: RallarMessageHandler<RallarMessagePayload> | undefined;
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
                    return createGroupSnapshotFixture({
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: roomId ?? 'missing',
                        sessionIds: [session.sessionId]
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
                        return createMessageDelivery('ws', undefined).handle;
                    },
                    onMessage(selector, handler) {
                        const selectorLabel = typeof selector === 'string'
                            ? selector
                            : `${String(selector.topicId)}:${String(selector.typeId)}`;
                        calls.push(`subscribe:${selectorLabel}`);
                        subscribedHandler = handler;
                        return () => calls.push('unsubscribe');
                    }
                }
            },
            ws: {
                status() {
                    return createWsStatus();
                }
            },
            rtc: {
                status() {
                    return createRtcStatus({});
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

        const received: RallarMessage<RallarMessagePayload>[] = [];
        const subscribeResult = await runDirectRallarWsSubscribe(
            {
                context: context,
                selector: { typeId: 'room.manual.message', topicId: 'room.manual.message' },
                handler: (message) => {
                    received.push(message);
                },
                readFacade: async () => facade
            }
        );
        await subscribedHandler?.(createDirectMessage({
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
        const sendValue = sendResult.value?.action === 'ws.send' ? sendResult.value : undefined;
        expect(sendValue?.sendResult).toMatchObject({ msgId: expect.any(String), typeId: 'test', lifecycle: { state: 'submitted' } });
        expect(JSON.parse(JSON.stringify(sendResult)).value.sendResult.lifecycle.state).toBe('submitted');
        expect(sendValue?.sendResult).not.toHaveProperty('wait');
        expect(received).toHaveLength(1);
        expect(sendResult.events.map((event) => event.topic)).toEqual([
            'rallar.direct.ws.send.started',
            'rallar.direct.ws.send.completed'
        ]);
        expect(sendResult.events.every((event) => event.transport === 'ws')).toBe(true);
    });

    it('reports a failed subscribe as a result that names its selector and drops the listener it registered', async () => {
        const calls: string[] = [];
        const selector = { typeId: 'room.manual.message', topicId: 'room.manual.message' };
        const facade: DirectRallarFacade = {
            configure() {},
            setDefaults() {},
            defaults() {
                return undefined;
            },
            async start() {
                return { session, connected: true };
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
                    return unsupportedOperation();
                },
                async join() {
                    throw new Error('room join refused');
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
                        return unsupportedOperation();
                    },
                    onMessage() {
                        calls.push('subscribe');
                        return () => calls.push('unsubscribe');
                    }
                }
            },
            ws: {
                status() {
                    return createWsStatus();
                }
            },
            rtc: {
                status() {
                    return createRtcStatus({});
                }
            }
        };

        const result = await runDirectRallarWsSubscribe({
            context: {
                providerMode: 'browser-rallar',
                apiBaseUrl: 'http://localhost:8080',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                roomId: 'bb-group',
                authSession: session
            },
            selector,
            handler: () => {},
            readFacade: async () => facade
        });

        expect(calls).toEqual(['subscribe', 'unsubscribe']);
        expect(result.status).toBe('failed');
        expect(result.value).toBeUndefined();
        expect(result.unsubscribe).toBeUndefined();
        expect(result.error).toMatchObject({
            code: 'RALLAR_DIRECT_OPERATION_FAILED',
            message: 'room join refused'
        });
        expect(result.events.at(-1)?.payload).toMatchObject({ action: 'ws.subscribe', selector });
    });
});

const snapshot: GroupSnapshot = createGroupSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'bb-group',
    sessionIds: [session.sessionId]
});
function unsupportedOperation(): never {
    throw new Error('Operation is outside this direct scenario');
}
function createWsStatus(): RallarWsStatus {
    return {
        readyState: 'open',
        connectState: 'connected',
        isOpen: true,
        reconnecting: false,
        reconnectEnabled: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectExhausted: false
    };
}
function createRtcStatus(input: Partial<RallarRtcStatus> = {}): RallarRtcStatus {
    return { laneId: 'default', knownPeerIds: [], activePeerIds: [], peerIdsWithNoReconnectableLanes: [], readyPeerIds: [], peers: [], ...input };
}
function createDirectTestFacade(input: Partial<DirectRallarFacade>): DirectRallarFacade {
    return {
        configure: () => {},
        setDefaults: () => {},
        defaults: () => undefined,
        start: unsupportedOperation,
        status: () => 'connected',
        isConnected: () => true,
        session: () => session,
        auth: { restore: () => session },
        rooms: { current: () => undefined, list: () => [], create: unsupportedOperation, join: unsupportedOperation },
        people: { list: () => [] },
        messages: { ws: { send: unsupportedOperation, onMessage: unsupportedOperation } },
        ws: { status: createWsStatus },
        rtc: { status: () => createRtcStatus() },
        ...input
    };
}
interface DirectMessageInput {
    readonly typeId: string;
    readonly topicId: string;
    readonly payload: RallarMessagePayload;
}
function createDirectMessage(input: DirectMessageInput): RallarMessage<RallarMessagePayload> {
    return {
        ...input,
        transport: 'ws',
        contextId: 'bb-group',
        resourceId: '',
        senderId: 'sender',
        receivedAtEpochMs: 1,
        raw: {
            id: { v: 2, msgId: 'message', senderId: 'sender', ts: 1 },
            route: { topicId: input.topicId, contextId: 'bb-group', resourceId: '' },
            payload: { typeId: input.typeId, contentType: 'application/json', resource: JSON.stringify(input.payload) }
        }
    };
}
