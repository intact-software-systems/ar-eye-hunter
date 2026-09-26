import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import {
    AL_CONTROL_NACK_TYPE_ID,
    ALMessage,
    ConnectionContext,
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultWsQueueBoxServerService,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALRoute,
    parseALControlMessage,
    type ALInboundRuntimeStores,
    type ALQosInputProvider,
    type WsServerTargetResolver
} from '@shared/mod.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { createTestGroup } from '../../create-test-group.ts';
import { waitForSettledALInboundWork } from '../../shared/wait-for-al-inbound-work.ts';

describe('RallarServerWsRouter', () => {
    it.each([-1, 0, 1])('retains the admitted policy deadline between handlers at deadline %+i ms', async (offsetMs) => {
        let nowMs = 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const expiresAtMs = nowMs + 1_000;
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const fixture = createIngressRouter({ defaultFanout: 'none' }, stores, {
            defaultsForMessage: () => ({ expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } })
        });
        const delivered: string[] = [];
        const observedDeadlines: (number | undefined)[] = [];
        fixture.router.on({ topicId: 'app.deadline' }, async (message) => {
            observedDeadlines.push(message.raw.constraints?.expiresAtMs);
            await Promise.resolve();
            nowMs = expiresAtMs + offsetMs;
        });
        fixture.router.on({ topicId: 'app.deadline' }, async (message) => {
            delivered.push(message.raw.id.msgId);
        });
        fixture.router.install();
        const message = newALBroadcastMessage('peer-1', newALRoute('app.deadline', 'message', 'all'), 'all', 'app.deadline.v1', {});

        await fixture.socket.receive(message);
        const keys = await stores.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        if (offsetMs < 0) {
            await expect.poll(() => stores.workQueue.getItem(keys[0])).toMatchObject({
                status: 'COMPLETED',
                dequeueAudit: { attempts: 1 }
            });
        }
        else {
            await expect.poll(() => stores.workQueue.getItem(keys[0])).toBeUndefined();
        }

        expect(observedDeadlines).toEqual([expiresAtMs]);
        expect(delivered).toEqual(offsetMs < 0 ? [message.id.msgId] : []);
        expect(message.constraints?.expiresAtMs).toBeUndefined();
    });

    it.each(['handler', 'proxy'] as const)('retries a failing public %s through the existing admission owner', async (consumer) => {
        vi.useFakeTimers();
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const fixture = createIngressRouter({ defaultFanout: 'none' }, stores);
        fixture.router.install();
        let available = false;
        const attempts: string[] = [];
        if (consumer === 'handler') {
            fixture.router.on({ topicId: 'app.retry' }, async (message) => {
                attempts.push(message.raw.id.msgId);
                if (!available) {
                    throw new Error('Application unavailable');
                }
            });
        }
        else {
            fixture.router.proxy({
                from: { topicId: 'app.retry' },
                transform: async (message) => {
                    attempts.push(message.raw.id.msgId);
                    if (!available) {
                        throw new Error('Proxy dependency unavailable');
                    }
                    return message.raw;
                }
            });
        }
        const message = newALBroadcastMessage('peer-1', newALRoute('app.retry', 'message', 'all'), 'all', 'app.retry.v1', {});

        await fixture.socket.receive(message);

        const keys = await stores.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(() => stores.workQueue.getItem(keys[0])).toMatchObject({ status: 'RETRY', dequeueAudit: { attempts: 1 } });
        const retry = await stores.workQueue.getItem(keys[0]);
        if (retry?.dequeueAudit.nextTs === undefined) {
            throw new Error('Expected the failed public consumer to retain a scheduled retry');
        }
        available = true;
        await vi.advanceTimersByTimeAsync(Math.max(0, retry.dequeueAudit.nextTs.epochMilliseconds - Date.now()));
        await expect.poll(() => stores.workQueue.getItem(keys[0])).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 2 } });
        expect(attempts).toEqual([message.id.msgId, message.id.msgId]);
    });

    it.each([-1, 0, 1])('checks expiry after asynchronous topic authorization at deadline %+i ms', async (offsetMs) => {
        let nowMs = 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const expiresAtMs = nowMs + 1_000;
        const fixture = createIngressRouter({ defaultFanout: 'none', nowEpochMs: () => nowMs });
        fixture.router.defineTopic({
            topicId: 'app.deadline',
            authorize: async () => {
                await Promise.resolve();
                nowMs = expiresAtMs + offsetMs;
                return true;
            }
        });
        const delivered: string[] = [];
        fixture.router.on({ topicId: 'app.deadline' }, async (message) => {
            delivered.push(message.raw.id.msgId);
        });
        const message = newALBroadcastMessage('peer-1', newALRoute('app.deadline', 'message', 'all'), 'all', 'app.deadline.v1', {}, { ttlMs: 1_000 });

        if (offsetMs < 0) {
            await expect(fixture.router.route(message)).resolves.toBeUndefined();
        }
        else {
            await expect(fixture.router.route(message)).rejects.toBeInstanceOf(NonRetryableException);
        }

        expect(delivered).toEqual(offsetMs < 0 ? [message.id.msgId] : []);
    });

    it('does not route a recognized state-sync payload on a user topic', async () => {
        const { router, socket, outbox } = createRouter();
        let handlerRan = false;
        let proxyTransformRan = false;
        router.on({ topicId: 'app.todo' }, () => {
            handlerRan = true;
        });
        router.proxy({
            from: { topicId: 'app.todo' },
            transform: (routedMessage) => {
                proxyTransformRan = true;
                return routedMessage.raw;
            },
            fanout: 'outbox'
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'forged-state-sync'),
            'all',
            AppTopics.groupStateSnapshot,
            { forged: true }
        );

        await router.route(message);

        expect(handlerRan).toBe(false);
        expect(proxyTransformRan).toBe(false);
        expect(await outbox.getAllKeys()).toEqual([]);
        expect(socket.sent).toHaveLength(0);
    });

    it('rejects repeated router installation before callback replacement', () => {
        const { router } = createRouter();

        router.install();

        expect(() => router.install()).toThrow(/already installed/i);
    });

    it('fans out implicit app topics to their declared targets', async () => {
        const { router, socket } = createRouter();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.cursor', 'all', 'cursor-1'),
            'all',
            'cursor.position.v1',
            { x: 1, y: 2 },
            {
                exceptPeerIds: ['peer-1']
            }
        );

        await router.route(message);

        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3'
        ]);
        expect(
            socket.sent.every((entry) => entry.data.id.msgId === message.id.msgId)
        ).toBe(true);
    });

    it('reserves rallar topics for system middleware and sends a NACK', async () => {
        const { router, socket } = createRouter();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('rallar.internal', 'all', 'secret-1'),
            'all',
            'internal.message.v1',
            { ok: false }
        );

        await router.route(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('uses lightweight validators for registered topics', async () => {
        const { router, socket } = createRouter();
        router.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            validate: (value) => typeof value === 'object' && value !== null && 'title' in value
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { done: true }
        );

        await router.route(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('dispatches registered handlers and allows default fanout to be disabled', async () => {
        const { router, socket } = createRouter();
        const handledPayloads: JsonWireValue[] = [];
        router.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'none',
            validate: () => true
        });
        router.on(
            { topicId: 'app.todo', typeId: 'todo.item.updated.v1' },
            async (handledMessage) => {
                handledPayloads.push(decodeJsonWireValue(handledMessage.payload));
            }
        );
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Ship router', done: false }
        );

        await router.route(message);

        expect(handledPayloads).toEqual([{
            title: 'Ship router',
            done: false
        }]);
        expect(socket.sent).toHaveLength(0);
    });

    it('can route registered topics through the QueueBox outbox', async () => {
        let outboxWakeRequested = false;
        const { router, outboundStores } = createRouter({
            wakeOutbox: () => {
                outboxWakeRequested = true;
            }
        });
        router.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'outbox'
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Durable fanout', done: false },
            {
                reliability: 'at-least-once',
                ack: 'none'
            }
        );

        await router.route(message);

        expect((await outboundStores.admissionStore.readSentMessage(message.id.msgId))?.msg).toMatchObject({
            id: message.id,
            route: message.route,
            targets: { mode: 'broadcast', scope: 'all' },
            payload: message.payload,
            delivery: { reliability: 'at-least-once', ack: 'none' },
            constraints: { expiresAtMs: message.id.ts + 30_000 }
        });
        expect(message.constraints).toBeUndefined();
        expect(outboxWakeRequested).toBe(true);
    });

    it('publishes a proxy room message with its full scoped identity', async () => {
        const { router, outboundStores } = createRouter();
        const roomRef: GroupRef = {
            applicationId: 'proxy-application',
            workspaceId: 'proxy-workspace',
            groupId: 'proxy-room'
        };
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.proxy', 'original-context', 'proxy-message'),
            'all',
            'proxy.message.v1',
            { text: 'scoped delivery' },
            { reliability: 'at-least-once', ack: 'receiver' }
        );
        router.defineTopic({ topicId: 'app.proxy', fanout: 'none' });
        router.on({ topicId: 'app.proxy' }, async (_message, context) => {
            await context.proxy.toRoom(roomRef, message, {
                fanout: 'outbox',
                exceptPeerIds: ['peer-2']
            });
        });

        await router.route(message);

        const retained = await outboundStores.admissionStore.readSentMessage(message.id.msgId);
        if (!retained) {
            throw new Error('Expected a persisted scoped proxy message');
        }
        const published = retained.msg;
        expect(published.targets).toEqual({
            mode: 'broadcast',
            scope: 'room',
            groupRef: roomRef,
            exceptPeerIds: ['peer-2']
        });
        expect(published.route).toEqual({ ...message.route, contextId: roomRef.groupId });
        expect(published.id).toEqual(message.id);
        expect(message.targets).toEqual({ mode: 'broadcast', scope: 'all' });
    });

    it('can require explicit topic definitions while still rejecting custom prefixes', async () => {
        const { router } = createRouter({ allowImplicitUserTopics: false });

        router.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1'
        });

        expect(() =>
            router.defineTopic({
                topicId: 'custom.todo',
                typeId: 'todo.item.updated.v1'
            })
        ).toThrow('Rallar user WS topic must start with app. or room.');
    });

    it('passes room broadcast target groupRef into room authorization context', async () => {
        const authorizeRoomMessage = vi.fn(() => true);
        const { router } = createRouter({
            authorizeRoomMessage
        });
        const group = createGroupSnapshot('room-1', ['peer-1'], 4).group;
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('room.chat', 'room-1', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'after join' },
            {
                groupRef: group,
                minSnapshotVersion: 4
            }
        );

        await router.route(message);

        expect(authorizeRoomMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                minSnapshotVersion: 4
            })
        );
    });

    it('rejects room messages as not-yet-in-sync when local cache is older than minSnapshotVersion', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const snapshot = createGroupSnapshot('room-1', ['peer-1'], 3);
            const { router, socket } = createRouter({
                authorizeRoomMessage: createGroupRoomWsAuthorizer({
                    readGroupSnapshot: () => snapshot,
                    readPreActivationAppData: () => 'allowed',
                    nowEpochMs: Date.now
                })
            });
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'room-1', 'msg-1'),
                'room',
                'chat.message.v1',
                { text: 'after join' },
                {
                    groupRef: snapshot.group,
                    minSnapshotVersion: 4
                }
            );

            await router.route(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
            const control = parseALControlMessage(socket.sent[0].data);
            if (control?.type !== 'nack') {
                throw new Error('Expected a decoded NACK control');
            }
            const nack = control.payload;
            expect(nack).toMatchObject({
                msgId: message.id.msgId,
                reason: 'not-yet-in-sync',
                serverSnapshotVersion: 3
            });
            expect(nack).not.toHaveProperty('groupId');
            expect(nack).not.toHaveProperty('minSnapshotVersion');
            expect(nack).not.toHaveProperty('retryAfterMs');
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects a stale room snapshot before AL admission without acknowledging the message', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const snapshot = createGroupSnapshot('room-1', ['peer-1'], 3);
            const { router, socket } = createIngressRouter({
                authorizeRoomMessage: createGroupRoomWsAuthorizer({
                    readGroupSnapshot: () => snapshot,
                    readPreActivationAppData: () => 'allowed',
                    nowEpochMs: Date.now
                })
            });
            router.install();
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'room-1', 'msg-pre-admission'),
                'room',
                'chat.message.v1',
                { text: 'too new' },
                {
                    groupRef: snapshot.group,
                    minSnapshotVersion: 4,
                    reliability: 'at-least-once',
                    ack: 'receiver'
                }
            );

            await socket.receive(message);

            expect(socket.sent).toHaveLength(1);
            expect(parseALControlMessage(socket.sent[0])).toMatchObject({
                type: 'nack',
                payload: {
                    msgId: message.id.msgId,
                    reason: 'not-yet-in-sync',
                    serverSnapshotVersion: 3
                }
            });
        }
        finally {
            warn.mockRestore();
        }
    });

    it('does not apply the user-topic room authorizer to reserved middleware messages', async () => {
        const { router, socket } = createIngressRouter({
            authorizeRoomMessage: () => false
        });
        router.install();
        const group = createGroupSnapshot('room-1', ['peer-1'], 1).group;
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(AppTopics.groupStateSnapshot, 'room-1', 'reserved-room-message'),
            'room',
            AppTopics.groupStateSnapshot,
            { snapshot: 'system-owned' },
            { groupRef: group }
        );

        await socket.receive(message);

        expect(socket.sent).toEqual([]);
    });

    it('keeps pre-admission room audiences bound to the first pending decision for each envelope', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const firstAdmissionRead = Promise.withResolvers<void>();
        const releaseFirstAdmission = Promise.withResolvers<void>();
        const allAuthorizationsCompleted = Promise.withResolvers<void>();
        const readIncomingMessage = stores.admissionStore.readIncomingMessage.bind(stores.admissionStore);
        let firstAdmissionBlocked = false;
        vi.spyOn(stores.admissionStore, 'readIncomingMessage').mockImplementation(async (input) => {
            if (!firstAdmissionBlocked) {
                firstAdmissionBlocked = true;
                firstAdmissionRead.resolve();
                await releaseFirstAdmission.promise;
            }
            return await readIncomingMessage(input);
        });
        const publishedAudiences: { readonly msgId: string; readonly sessionIds: readonly string[]; }[] = [];
        let authorizationCount = 0;
        const group = createGroupSnapshot('room-1', ['peer-1'], 1).group;
        const { router, service, socket } = createIngressRouter({
            nowEpochMs: () => 1,
            authorizeRoomMessage: ({ message }) => {
                if (!message.targets) {
                    return false;
                }
                authorizationCount += 1;
                if (authorizationCount === 3) {
                    allAuthorizationsCompleted.resolve();
                }
                return {
                    authorized: true,
                    audience: {
                        targets: message.targets,
                        sessions: Array.from({ length: authorizationCount }, (_, index) => createGroupPresenceRecord('room-1', `session-${index + 1}`, 1)),
                        snapshotVersion: 1
                    }
                };
            }
        }, stores);
        const sendToTargetsWithResult = service.sendToTargetsWithResult.bind(service);
        vi.spyOn(service, 'sendToTargetsWithResult').mockImplementation((message, sessionIds) => {
            publishedAudiences.push({ msgId: message.id.msgId, sessionIds: [...sessionIds ?? []] });
            return sendToTargetsWithResult(message, sessionIds);
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            router.install();
            const first = newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'room-1', 'shared-id'),
                'room',
                'chat.message.v1',
                { text: 'first' },
                { groupRef: group }
            );
            const second = {
                ...newALBroadcastMessage(
                    'peer-1',
                    newALRoute('room.chat', 'room-1', 'second-id'),
                    'room',
                    'chat.message.v1',
                    { text: 'second' },
                    { groupRef: group }
                ),
                id: first.id
            };

            const firstIngress = socket.receive(first);
            await firstAdmissionRead.promise;
            const duplicateIngress = socket.receive(first);
            const alteredIngress = socket.receive(second);
            await allAuthorizationsCompleted.promise;
            releaseFirstAdmission.resolve();
            await Promise.all([firstIngress, duplicateIngress, alteredIngress]);
            const keys = await stores.workQueue.getAllKeys();
            expect(keys.length).toBeGreaterThan(0);
            await waitForSettledALInboundWork(stores.workQueue);

            expect(publishedAudiences).toEqual([{
                msgId: first.id.msgId,
                sessionIds: ['session-1']
            }]);
        }
        finally {
            error.mockRestore();
            warn.mockRestore();
        }
    });

    it('stamps the admission-time audience with the snapshot version it was read at', async () => {
        const group = createGroupSnapshot('room-1', ['peer-1'], 1).group;
        const { router, socket } = createIngressRouter({
            nowEpochMs: () => 1,
            authorizeRoomMessage: ({ message }) =>
                message.targets === undefined ? false : {
                    authorized: true,
                    audience: {
                        targets: message.targets,
                        sessions: [createGroupPresenceRecord('room-1', 'peer-2', 1)],
                        snapshotVersion: 9
                    }
                }
        });
        router.install();
        const message: ALMessage = {
            ...newALBroadcastMessage('peer-1', newALRoute('room.chat', 'room-1', 'stamp-1'), 'room', 'chat.message.v1', {}, {
                groupRef: group
            }),
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        };

        await socket.receive(message);

        await expect.poll(() =>
            socket.sent
                .filter((sent) => sent.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
                .map((sent) => JSON.parse(sent.payload.resource))
        ).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: ['peer-2'], snapshotVersion: 9 })
        ]);
    });

    it('keeps a session that leaves the room after admission in the live-only audience it was admitted to (D43)', async () => {
        const fixture = createAudienceRouter({
            admittedSessionIds: ['peer-1', 'peer-2', 'peer-3'],
            currentSessionIds: ['peer-1', 'peer-2'],
            disconnectedSessionIds: [],
            fanout: 'live-only'
        });
        const message = createReceiverRoomBroadcast('left-after-admission');

        await fixture.sockets['peer-1']!.receive(message);

        await expect.poll(() => readChatRecipients(fixture)).toEqual(['peer-1', 'peer-2', 'peer-3']);
    });

    it('sends only to the connected part of the admitted audience and keeps the disconnected one expected', async () => {
        const fixture = createAudienceRouter({
            admittedSessionIds: ['peer-1', 'peer-2', 'peer-3'],
            currentSessionIds: ['peer-1', 'peer-2', 'peer-3'],
            disconnectedSessionIds: ['peer-3'],
            fanout: 'live-only'
        });
        const message = createReceiverRoomBroadcast('disconnected-after-admission');

        await fixture.sockets['peer-1']!.receive(message);

        await expect.poll(() => readChatRecipients(fixture)).toEqual(['peer-1', 'peer-2']);
        await expect.poll(() => readReceipts(fixture.sockets['peer-1']!)).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: ['peer-2', 'peer-3'] })
        ]);
    });

    it.each([
        { frozen: ['peer-2'], expected: ['peer-2'], label: 'honours a frozen audience narrower than the room' },
        { frozen: ['peer-2', 'stranger'], expected: ['peer-2'], label: 'trims a frozen audience naming a non-member' }
    ])('$label on an RTC-frozen multicast that fell back to WS', async ({ frozen, expected }) => {
        const fixture = createAudienceRouter({
            admittedSessionIds: ['peer-1', 'peer-2', 'peer-3'],
            currentSessionIds: ['peer-1', 'peer-2', 'peer-3'],
            disconnectedSessionIds: [],
            fanout: 'live-only'
        });
        const message: ALMessage = {
            ...createReceiverRoomBroadcast('fell-back'),
            targets: { mode: 'multicast', groupRef: AUDIENCE_ROOM, recipientPeerIds: frozen, snapshotVersion: 3 }
        };

        await fixture.sockets['peer-1']!.receive(message);

        await expect.poll(() => readReceipts(fixture.sockets['peer-1']!)).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: expected })
        ]);
        await expect.poll(() => readChatRecipients(fixture)).toEqual(expected);
    });

    it('sends an outbox-fanned room broadcast to its admission audience and expects exactly it, never a later local session', async () => {
        const fixture = createAudienceRouter({
            admittedSessionIds: ['peer-1', 'peer-2'],
            currentSessionIds: ['peer-1', 'peer-2', 'peer-4'],
            disconnectedSessionIds: [],
            fanout: 'outbox'
        });
        const message = createReceiverRoomBroadcast('outbox-admitted-audience');

        await fixture.sockets['peer-1']!.receive(message);

        await expect.poll(() => readChatRecipients(fixture)).toEqual(['peer-1', 'peer-2']);
        expect(await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'peer-1', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['peer-2'], ackedPeerIds: [] });
        expect(fixture.sockets['peer-4']!.sent.filter((sent) => sent.payload.typeId === 'chat.message.v1')).toEqual([]);
    });

    it.each(
        [
            { ack: 'best-effort', delivery: { reliability: 'best-effort', ack: 'none' }, qos: undefined },
            { ack: 'hop', delivery: undefined, qos: { ack: { algo: 'hop' }, durability: { algo: 'local-outbox' } } },
            { ack: 'receiver', delivery: { reliability: 'at-least-once', ack: 'receiver' }, qos: undefined }
        ] as const
    )('admits and delivers an outbox-fanned $ack room broadcast to a room larger than the wire collection limit', async ({ delivery, qos }) => {
        const sessionIds = Array.from({ length: 300 }, (_, index) => `session-${String(index).padStart(3, '0')}`);
        const fixture = createLargeOutboxRoom(sessionIds);
        const message: ALMessage = {
            ...createReceiverRoomBroadcast('large-room'),
            id: { v: 2, msgId: 'large-room-1', ts: Date.now(), senderId: sessionIds[0]! },
            delivery,
            qos
        };

        await fixture.router.route(message, { kind: 'ws-client', peerId: sessionIds[0]!, groupRecipientPeerIds: sessionIds });

        await expect.poll(() => Object.values(fixture.sockets).filter((socket) => socket.sent.some((sent) => sent.id.msgId === 'large-room-1')).length).toBe(
            sessionIds.length
        );
        const delivered = Object.values(fixture.sockets).flatMap((socket) => socket.sent.filter((sent) => sent.id.msgId === 'large-room-1'));
        expect(delivered.every((sent) => sent.targets?.mode === 'broadcast' && sent.targets.recipientPeerIds === undefined)).toBe(true);
    });

    it('intersects a retained audience with current resolver recipients when authorization delegates audience resolution', async () => {
        const { router, socket } = createRouter({ authorizeRoomMessage: () => true });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('room.chat', 'room-1', 'retained-audience'),
            'room',
            'chat.message.v1',
            { text: 'original audience only' },
            { groupRef: createGroupSnapshot('room-1', ['peer-1'], 1).group }
        );

        await router.route(message, { kind: 'ws-client', peerId: 'peer-1', groupRecipientPeerIds: ['peer-2', 'departed-peer'] });

        expect(socket.sent.map((entry) => entry.connectionId)).toEqual(['conn-2']);
    });
});

describe('RallarServer.ws.publish current behavior', () => {
    it('returns the live-only send count and sends to resolved targets', async () => {
        const { server, socket } = createPublicRouterFixture();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.cursor', 'all', 'cursor-1'),
            'all',
            'cursor.position.v1',
            { x: 1, y: 2 },
            {
                exceptPeerIds: ['peer-1']
            }
        );

        const result = await server.ws.publish(message, 'live-only');

        expect(result).toMatchObject({
            fanout: 'live-only',
            status: 'sent-live',
            sentCount: 2,
            recipientCount: 2,
            failedCount: 0,
            entries: []
        });
        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3'
        ]);
        expect(
            socket.sent.every((entry) => entry.data.id.msgId === message.id.msgId)
        ).toBe(true);
    });

    it('returns 0 for live-only fanout with zero recipients', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { server, socket } = createPublicRouterFixture({
                targetResolver: {
                    ...createTargetResolver(),
                    resolveBroadcastRecipients: () => []
                }
            });
            const message = newALBroadcastMessage(
                'server-1',
                newALRoute('app.cursor', 'all', 'cursor-1'),
                'all',
                'cursor.position.v1',
                { x: 1, y: 2 }
            );

            const result = await server.ws.publish(message, 'live-only');

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'no-recipients',
                sentCount: 0,
                recipientCount: 0,
                failedCount: 0,
                entries: []
            });
            expect(socket.sent).toHaveLength(0);
            expect(warn).toHaveBeenCalledWith(
                'Rallar server WS topic had no recipients: app.cursor'
            );
        }
        finally {
            warn.mockRestore();
        }
    });

    it('returns partial-failure metadata for live-only send failures', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { server, socket } = createPublicRouterFixture({
                failingConnectionIds: ['conn-2']
            });
            const message = newALBroadcastMessage(
                'server-1',
                newALRoute('app.cursor', 'all', 'cursor-1'),
                'all',
                'cursor.position.v1',
                { x: 1, y: 2 }
            );

            const result = await server.ws.publish(message, 'live-only');

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'partial-failure',
                sentCount: 2,
                recipientCount: 3,
                failedCount: 1,
                entries: [],
                failures: [
                    {
                        peerId: 'peer-2',
                        connectionId: 'conn-2',
                        reason: 'send failed'
                    }
                ]
            });
            expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
                'conn-1',
                'conn-3'
            ]);
        }
        finally {
            error.mockRestore();
        }
    });

    it('returns queued-outbox metadata for durable outbox fanout', async () => {
        const { server, socket, outboundStores, qboxEngine } = createPublicRouterFixture();
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-1'),
            'room',
            'todo.item.updated.v1',
            { title: 'Durable fanout', done: false },
            {
                groupRef,
                reliability: 'at-least-once',
                ack: 'receiver'
            }
        );

        const result = await server.ws.publish(message, 'outbox');

        expect(result).toMatchObject({
            fanout: 'outbox',
            status: 'queued-outbox',
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 }
        });
        expect(result.entries).toHaveLength(1);
        expect((await outboundStores.admissionStore.readSentMessage(message.id.msgId))?.msg).toMatchObject({
            id: message.id,
            route: message.route,
            targets: { mode: 'broadcast', scope: 'room', groupRef },
            payload: message.payload,
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            constraints: { expiresAtMs: message.id.ts + 30_000 }
        });
        expect(message.constraints).toBeUndefined();
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wakeRequested).toBe(true);
    });

    it('maps a deferred admission verdict to skipped status', async () => {
        const { server, socket, service, qboxEngine } = createPublicRouterFixture();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-deferred'),
            'room',
            'todo.item.updated.v1',
            { title: 'Deferred fanout', done: false },
            {
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                reliability: 'at-least-once',
                ack: 'receiver'
            }
        );
        const verdict: ALDeliveryAdmissionVerdict = {
            kind: 'deferred',
            reason: 'not-yet-in-sync',
            detail: 'Group snapshot not yet applied'
        };
        vi.spyOn(service, 'enqueueOutboxIfAbsent').mockResolvedValue({
            verdict,
            message,
            entries: [],
            reason: verdict.detail
        });

        const result = await server.ws.publish(message, 'outbox');

        expect(result).toMatchObject({ fanout: 'outbox', status: 'skipped', verdict });
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wakeRequested).toBe(false);
    });

    it.each([
        { reason: 'unauthorized' as const, expectedStatus: 'skipped' as const },
        { reason: 'malformed' as const, expectedStatus: 'failed' as const }
    ])('maps a refused admission verdict with reason $reason to status $expectedStatus', async ({ reason, expectedStatus }) => {
        const { server, socket, service, qboxEngine } = createPublicRouterFixture();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', `todo-refused-${reason}`),
            'room',
            'todo.item.updated.v1',
            { title: 'Refused fanout', done: false },
            {
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                reliability: 'at-least-once',
                ack: 'receiver'
            }
        );
        const verdict: ALDeliveryAdmissionVerdict = {
            kind: 'refused',
            reason,
            detail: `Outbound candidate refused: ${reason}`
        };
        vi.spyOn(service, 'enqueueOutboxIfAbsent').mockResolvedValue({
            verdict,
            message,
            entries: [],
            reason: verdict.detail
        });

        const result = await server.ws.publish(message, 'outbox');

        expect(result).toMatchObject({ fanout: 'outbox', status: expectedStatus, verdict });
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wakeRequested).toBe(false);
    });

    it('rejects a durable room broadcast before the router can queue an unscoped envelope', async () => {
        const { server, socket, outbox, qboxEngine } = createPublicRouterFixture();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-invalid-room'),
            'room',
            'todo.item.updated.v1',
            { title: 'Invalid durable fanout', done: false },
            {
                reliability: 'at-least-once',
                ack: 'receiver'
            }
        );

        await expect(server.ws.publish(message, 'outbox')).rejects.toThrow(
            /room broadcast group ref/i
        );

        expect(await outbox.getAllKeys()).toEqual([]);
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wakeRequested).toBe(false);
    });

    it('returns none metadata without sending or enqueueing', async () => {
        const { server, socket, outbox } = createPublicRouterFixture();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-1'),
            'room',
            'todo.item.updated.v1',
            { title: 'No fanout', done: false }
        );

        const result = await server.ws.publish(message, 'none');

        expect(result).toMatchObject({
            fanout: 'none',
            status: 'none',
            sentCount: 0,
            entries: []
        });
        expect(socket.sent).toHaveLength(0);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('reports minimal server websocket status from current connections', () => {
        const { server, socket } = createPublicRouterFixture();
        socket.connections.delete('conn-3');
        const closed = socket.connections.get('conn-2');
        if (!closed || !(closed.socket instanceof RouterIngressWebSocket)) {
            throw new Error('Expected the fixture native WebSocket');
        }
        closed.socket.readyState = WebSocket.CLOSED;

        expect(server.ws.status()).toEqual({
            transport: 'ws-server',
            connectionCount: 2,
            openConnectionCount: 1,
            connectionIds: ['conn-1', 'conn-2'],
            openConnectionIds: ['conn-1'],
            connections: [
                {
                    connectionId: 'conn-1',
                    isOpen: true
                },
                {
                    connectionId: 'conn-2',
                    isOpen: false
                }
            ]
        });
    });
});

interface RouterFixture {
    readonly router: RallarServerWsRouter;
    readonly service: WsQueueBoxServerService;
    readonly socket: RecordingWsServer;
    readonly outbox: QueueBoxResourceEntryRepository;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

function createRouter(
    options?: ConstructorParameters<typeof RallarServerWsRouter>[1]
): RouterFixture {
    const socket = createRecordingWsServer();
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const outbox = outboundStores.workQueue;
    const service = createDefaultWsQueueBoxServerService({
        outbox,
        outboundStores,
        socket,
        name: 'server-1',
        targetResolver: createTargetResolver()
    });
    const router = new RallarServerWsRouter(service, options);
    onTestFinished(() => service.dispose());

    return {
        router,
        service,
        socket,
        outbox,
        outboundStores
    };
}

interface IngressRouterFixture {
    readonly router: RallarServerWsRouter;
    readonly service: WsQueueBoxServerService;
    readonly socket: RouterIngressWebSocket;
}

function createIngressRouter(
    options: ConstructorParameters<typeof RallarServerWsRouter>[1],
    inboundStores?: ALInboundRuntimeStores,
    qosProvider?: ALQosInputProvider
): IngressRouterFixture {
    const server = new JsonWebSocketServer();
    const socket = new RouterIngressWebSocket();
    server.addConnection(new ConnectionContext({ id: 'conn-1', socket }));
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'server-1',
        inboundStores,
        qosProvider,
        targetResolver: {
            resolvePeerIdForConnection: () => 'peer-1',
            resolvePeerRecipients: (peerId) =>
                peerId === 'peer-1'
                    ? [{ peerId, connectionId: 'conn-1' }]
                    : [],
            resolveBroadcastRecipients: () => []
        }
    });
    onTestFinished(() => service.dispose());
    return { router: new RallarServerWsRouter(service, options), service, socket };
}

const AUDIENCE_ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

interface AudienceRouterFixture {
    readonly router: RallarServerWsRouter;
    readonly sockets: Readonly<Record<string, RouterIngressWebSocket>>;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

interface AudienceRouterInput {
    readonly admittedSessionIds: readonly string[];
    readonly currentSessionIds: readonly string[];
    readonly disconnectedSessionIds: readonly string[];
    /** `outbox`: the room topic leaves through the server's own outbound owner, to every session connected here. */
    readonly fanout: 'live-only' | 'outbox';
}

/**
 * One connection per session, named by its session id. Admission authorizes `admittedSessionIds`; every
 * later authorization, which the route makes at dispatch, sees `currentSessionIds`, and by then the
 * sockets of `disconnectedSessionIds` have closed.
 */
function createAudienceRouter(input: AudienceRouterInput): AudienceRouterFixture {
    const { admittedSessionIds, currentSessionIds, disconnectedSessionIds } = input;
    const server = new JsonWebSocketServer();
    const sockets = Object.fromEntries(
        ['peer-1', 'peer-2', 'peer-3', 'peer-4'].map((sessionId) => [sessionId, new RouterIngressWebSocket()])
    );
    for (const [sessionId, socket] of Object.entries(sockets)) {
        server.addConnection(new ConnectionContext({ id: sessionId, socket }));
    }
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: server,
        name: 'server-1',
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => input.fanout === 'outbox' ? Object.keys(sockets).map((peerId) => ({ peerId, connectionId: peerId })) : []
        }
    });
    onTestFinished(() => service.dispose());
    let authorizations = 0;
    const router = new RallarServerWsRouter(service, {
        nowEpochMs: () => 1,
        authorizeRoomMessage: ({ message }) => {
            authorizations += 1;
            if (authorizations === 2) {
                for (const sessionId of disconnectedSessionIds) {
                    sockets[sessionId]!.readyState = WebSocket.CLOSED;
                }
            }
            const sessionIds = authorizations === 1 ? admittedSessionIds : currentSessionIds;
            return message.targets === undefined ? false : {
                authorized: true,
                audience: {
                    targets: message.targets,
                    sessions: sessionIds.map((sessionId) => createGroupPresenceRecord('room-1', sessionId, 3)),
                    snapshotVersion: 3
                }
            };
        }
    });
    router.install().defineTopic({ topicId: 'room.chat', fanout: input.fanout });
    return { router, sockets, outboundStores };
}

/** A room of `sessionIds`, each connected here, whose room topic fans out through the server outbox. */
function createLargeOutboxRoom(sessionIds: readonly string[]): Omit<AudienceRouterFixture, 'outboundStores'> {
    const server = new JsonWebSocketServer();
    const sockets = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, new RouterIngressWebSocket()]));
    for (const [sessionId, socket] of Object.entries(sockets)) {
        server.addConnection(new ConnectionContext({ id: sessionId, socket }));
    }
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: server,
        name: 'server-1',
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => sessionIds.map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    const router = new RallarServerWsRouter(service, {
        nowEpochMs: () => 1,
        authorizeRoomMessage: ({ message }) =>
            message.targets === undefined ? false : {
                authorized: true,
                audience: {
                    targets: message.targets,
                    sessions: sessionIds.map((sessionId) => createGroupPresenceRecord('room-1', sessionId, 3)),
                    snapshotVersion: 3
                }
            }
    });
    router.install().defineTopic({ topicId: 'room.chat', fanout: 'outbox' });
    return { router, sockets };
}

function createReceiverRoomBroadcast(resourceId: string): ALMessage {
    return {
        ...newALBroadcastMessage('peer-1', newALRoute('room.chat', 'room-1', resourceId), 'room', 'chat.message.v1', {}, {
            groupRef: AUDIENCE_ROOM
        }),
        delivery: { reliability: 'at-least-once', ack: 'receiver' }
    };
}

function readChatRecipients(fixture: AudienceRouterFixture): readonly string[] {
    return Object.entries(fixture.sockets)
        .filter(([, socket]) => socket.sent.some((sent) => sent.payload.typeId === 'chat.message.v1'))
        .map(([sessionId]) => sessionId);
}

function readReceipts(socket: RouterIngressWebSocket): readonly ALReceiptPayload[] {
    return socket.sent.flatMap((sent) => {
        const control = parseALControlMessage(sent);
        return control?.type === 'receipt' ? [control.payload] : [];
    });
}

class RouterIngressWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readyState: WebSocket['readyState'] = WebSocket.OPEN;
    readonly url = 'ws://router-ingress-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    readonly sent: ALMessage[] = [];
    private readonly messageListeners: EventListenerOrEventListenerObject[] = [];

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, callback, options);
        if (type === 'message' && callback !== null) {
            this.messageListeners.push(callback);
        }
    }

    close(): void {}

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== 'string') {
            throw new TypeError('Router ingress test expects JSON text');
        }
        this.sent.push(decodePersistedALMessage(data));
    }

    async receive(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });
        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
        }
    }
}

interface PublicRouterFixtureInput {
    readonly targetResolver?: WsServerTargetResolver;
    readonly failingConnectionIds?: readonly string[];
}

interface PublicRouterTestServer {
    readonly ws: RallarServerWsRouter;
}

interface RouterQueueWakeRecorder {
    wakeRequested: boolean;
    wake(): void;
}

interface PublicRouterFixture {
    readonly server: PublicRouterTestServer;
    readonly service: WsQueueBoxServerService;
    readonly socket: RecordingWsServer;
    readonly outbox: QueueBoxResourceEntryRepository;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly qboxEngine: RouterQueueWakeRecorder;
}

function createPublicRouterFixture(options: PublicRouterFixtureInput = {}): PublicRouterFixture {
    const socket = createRecordingWsServer({
        failingConnectionIds: options.failingConnectionIds
    });
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const outbox = outboundStores.workQueue;
    const service = createDefaultWsQueueBoxServerService({
        outbox,
        outboundStores,
        socket,
        name: 'server-1',
        targetResolver: options.targetResolver ?? createTargetResolver()
    });
    const qboxEngine = {
        wakeRequested: false,
        wake() {
            this.wakeRequested = true;
        }
    };
    onTestFinished(() => service.dispose());
    const server = {
        ws: new RallarServerWsRouter(service, {
            wakeOutbox: () => qboxEngine.wake()
        })
    };

    return {
        server,
        service,
        socket,
        outbox,
        outboundStores,
        qboxEngine
    };
}

interface RecordingWsServerInput {
    readonly failingConnectionIds?: readonly string[];
}

interface RecordedWsSend {
    readonly connectionId: string;
    readonly data: ALMessage;
}

interface RecordingWsServer extends JsonWebSocketServer {
    readonly sent: RecordedWsSend[];
}

function createRecordingWsServer(options: RecordingWsServerInput = {}): RecordingWsServer {
    const sent: RecordedWsSend[] = [];
    const server = new JsonWebSocketServer();
    const failingConnectionIds = new Set(options.failingConnectionIds ?? []);
    for (const connectionId of ['conn-1', 'conn-2', 'conn-3']) {
        const socket = new RouterIngressWebSocket();
        socket.send = (data) => {
            if (failingConnectionIds.has(connectionId)) {
                throw new Error('send failed');
            }
            if (typeof data !== 'string') {
                throw new TypeError('Router fixture expects a serialized AL frame');
            }
            sent.push({ connectionId, data: decodePersistedALMessage(data) });
        };
        server.addConnection(new ConnectionContext({ id: connectionId, socket }));
    }
    return Object.assign(server, { sent });
}

function createTargetResolver(): WsServerTargetResolver {
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3'
    };

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [
                    {
                        peerId,
                        connectionId
                    }
                ]
                : [];
        },
        resolveBroadcastRecipients: () =>
            Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
                peerId,
                connectionId
            }))
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    snapshotVersion: number
): GroupSnapshot {
    const ownerPrincipalId = requireGroupOwner(sessionIds);
    const members = sessionIds.map((sessionId) => createGroupMemberRecord({ groupId, ownerPrincipalId, sessionId, snapshotVersion }));
    const activeSessions = sessionIds.map((sessionId) => createGroupPresenceRecord(groupId, sessionId, snapshotVersion));
    return {
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion
        },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            slug: groupId,
            displayName: groupId,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(snapshotVersion, ownerPrincipalId)
        }),
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length
    };
}

function requireGroupOwner(sessionIds: readonly string[]): string {
    const ownerPrincipalId = sessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }
    return ownerPrincipalId;
}

interface CreateGroupMemberRecordInput {
    readonly groupId: string;
    readonly ownerPrincipalId: string;
    readonly sessionId: string;
    readonly snapshotVersion: number;
}

function createGroupMemberRecord(input: CreateGroupMemberRecordInput): GroupMember {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: input.groupId,
        principalId: input.sessionId,
        role: input.sessionId === input.ownerPrincipalId ? 'owner' : 'member',
        status: 'active',
        joined: createAuditStamp(1, input.ownerPrincipalId),
        updated: createAuditStamp(input.snapshotVersion, input.ownerPrincipalId),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createGroupPresenceRecord(
    groupId: string,
    sessionId: string,
    snapshotVersion: number
): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: snapshotVersion,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: snapshotVersion,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}
