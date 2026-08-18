import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

// TypeScript declares a native `globalThis.Temporal` whose shape differs from the polyfill's, so
// the polyfill has to be installed through a property definition rather than a typed assignment.
if (!('Temporal' in globalThis)) {
    Object.defineProperty(globalThis, 'Temporal', {
        configurable: true,
        value: Temporal,
        writable: true,
    });
}

type SharedModule = typeof import('@shared/mod.ts');
type SharedMessage = import('@shared/mod.ts').ALMessage;

let shared: SharedModule;

beforeAll(async () => {
    shared = await import('@shared/mod.ts');
});

describe('multicast QoS integration', () => {
    it('uses the shared handling planner to produce forwarding copies', () => {
        const connectionService = createConnectionService([
            'peer-1',
            'peer-2',
            'peer-3',
        ]);
        const service = new shared.WebRtcOverlayMulticastService(
            'group-1',
            connectionService as never,
        );
        const msg = {
            ...shared.newALMulticastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'group-1',
                },
                groupRef('group-1'),
                'chat.typing.v1',
                {
                    text: 'typing',
                },
                {
                    ttlHops: 2,
                    qos: {
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1,
                            },
                        },
                        durability: {
                            algo: 'volatile',
                        },
                    },
                },
            ),
            diagnostics: {
                visitedPeerIds: ['peer-3'],
            },
        };

        const plan = service.createForwardingPlan(
            msg,
            createOverlayContext(['self', 'peer-1', 'peer-2', 'peer-3'], [
                'peer-1',
                'peer-2',
                'peer-3',
            ]),
            'peer-1',
        );

        expect(plan.handlingPlan.dropReason).toBeUndefined();
        expect(plan.handlingPlan.forwarding.persist).toBe(false);
        expect(plan.handlingPlan.forwarding.nextHopPeerIds).toEqual(['peer-2']);
        expect(plan.handlingPlan.ack.algo).toBe('none');
        expect(plan.transportMessages).toHaveLength(1);
        expect(plan.transportMessages[0].constraints?.ttlHops).toBe(1);
        expect(plan.transportMessages[0].diagnostics?.visitedPeerIds).toEqual([
            'peer-3',
            'self',
        ]);
        expect(plan.transportMessages[0].forwarding?.nextHopPeerIds).toEqual([
            'peer-2',
        ]);
    });

    it('sends volatile multicast immediately instead of queueing it', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1']),
            }),
            createReadableCache({
                'group-1': createOverlayInfo(['peer-1']),
            }),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALMulticastMessage(
            'sender-2',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.typing.v1',
            {
                text: 'typing',
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10,
        );

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('queues durable multicast so dequeue controls retries', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1']),
            }),
            createReadableCache({
                'group-1': createOverlayInfo(['peer-1']),
            }),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALMulticastMessage(
            'sender-3',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello',
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
            },
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10,
        );

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
        expect(reserved.size).toBe(1);
    });

    it('dequeues durable multicast through the shared outbound runtime', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1']),
            }),
            createReadableCache({
                'group-1': createOverlayInfo(['peer-1']),
            }),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALMulticastMessage(
            'sender-3b',
            {
                topicId: 'chat',
                resourceId: 'msg-3b',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello again',
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
            },
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
    });

    it('repairs multicast ack timeouts by rerouting to an alternate parent', async () => {
        vi.useFakeTimers();

        try {
            const connectionService = createConnectionService(['peer-1', 'peer-2']);
            const queue = new shared.InMemoryQueueBox(new Map());
            const manager = new shared.WebRtcOverlayMulticastManager(
                queue,
                connectionService as never,
                createReadableCache({
                    'group-1': createGroupSnapshot(['self', 'peer-1', 'peer-2']),
                }),
                createReadableCache({
                    'group-1': createOverlayInfo(['peer-1', 'peer-2']),
                }),
                (overlayId) =>
                    new shared.WebRtcOverlayMulticastService(
                        overlayId,
                        connectionService as never,
                    ),
            );

            const msg = shared.newALMulticastMessage(
                'sender-3c',
                {
                    topicId: 'chat',
                    resourceId: 'msg-3c',
                    contextId: 'group-1',
                },
                groupRef('group-1'),
                'chat.message.v1',
                {
                    text: 'repair via alternate parent',
                },
                {
                    qos: {
                        delivery: {
                            algo: 'at-least-once',
                        },
                        durability: {
                            algo: 'volatile',
                        },
                        ack: {
                            algo: 'hop',
                            opts: {
                                timeoutMs: 100,
                            },
                        },
                        retry: {
                            algo: 'exp-backoff',
                            opts: {
                                maxAttempts: 1,
                            },
                        },
                        repair: {
                            algo: 'retransmit',
                            opts: {
                                maxRepairs: 1,
                            },
                        },
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1,
                            },
                        },
                    },
                },
            );

            await manager.enqueueIfAbsent(msg);
            await manager.dequeue(
                shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                createResilienceDto(),
            );

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toBeUndefined();

            await vi.advanceTimersByTimeAsync(100);

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(1);
            expect(
                (connectionService.sendByPeerId.get('peer-2')?.[0] as SharedMessage).id
                    .msgId,
            )
                .toBe(msg.id.msgId);
        } finally {
            vi.useRealTimers();
        }
    });

    it('targets repair retransmits to the requesting rtc peer', async () => {
        const connectionService = createConnectionService(['peer-1', 'peer-2']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1', 'peer-2']),
            }),
            createReadableCache({
                'group-1': createOverlayInfo(['peer-1', 'peer-2']),
            }),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALMulticastMessage(
            'sender-3d',
            {
                topicId: 'chat',
                resourceId: 'msg-3d',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'repair just one peer',
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );
        await manager.acceptControlMessage(
            shared.newALRepairControlMessage(
                'peer-2',
                'self',
                msg.id.msgId,
                'retransmit',
            ),
        );

        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(2);
        expect(
            (connectionService.sendByPeerId.get('peer-2')?.[1] as SharedMessage).id
                .msgId,
        )
            .toBe(msg.id.msgId);
    });

    it('sends volatile unicast immediately through the same planning path', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALUnicastMessage(
            'sender-4',
            {
                topicId: 'chat',
                resourceId: 'msg-4',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'private hello',
            },
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10,
        );

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('does not call raw RTC send when the next-hop channel is not open', async () => {
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': 'connecting',
        });
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALUnicastMessage(
            'sender-4b',
            {
                topicId: 'chat',
                resourceId: 'msg-4b',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'warming hello',
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        await manager.enqueueIfAbsent(msg);

        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
    });

    it('queues durable unicast when qos requests persistence', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = shared.newALUnicastMessage(
            'sender-5',
            {
                topicId: 'chat',
                resourceId: 'msg-5',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'durable hello',
            },
            {
                qos: {
                    delivery: {
                        algo: 'at-least-once',
                    },
                    durability: {
                        algo: 'local-outbox',
                    },
                    ack: {
                        algo: 'hop',
                        opts: {
                            timeoutMs: 1_500,
                        },
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 4,
                        },
                    },
                },
            },
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10,
        );

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
        expect(reserved.size).toBe(1);
    });
});

function createConnectionService(
    connectedPeerIds: readonly string[],
    readyStates: Readonly<Record<string, RTCDataChannelState>> = {},
) {
    const sendByPeerId = new Map<string, unknown[]>();

    return {
        input: {
            sessionId: 'self',
        },
        readyPeerIdsForLane: () => [...connectedPeerIds],
        readPeer: (peerId: string) => ({
            channel: {
                readHealth: vi.fn(() => ({
                    readyState: readyStates[peerId] ?? 'open',
                })),
                send: vi.fn(async (msg: unknown) => {
                    const sent = sendByPeerId.get(peerId) ?? [];
                    sent.push(msg);
                    sendByPeerId.set(peerId, sent);
                }),
            },
        }),
        sendByPeerId,
    };
}

function createOverlayContext(
    memberSessionIds: readonly string[],
    nextHopSessionIds: readonly string[],
) {
    return {
        overlayId: 'group-1',
        room: createGroupSnapshot(memberSessionIds),
        overlay: createOverlayInfo(nextHopSessionIds),
    };
}

function createGroupSnapshot(memberSessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const groupId = 'group-1';
    const audit = createAuditStamp('owner');

    return {
        stateRevision: 1,
        causalRevision: {
            groupRevision: 1,
            presenceRevision: 0,
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: 'Group 1',
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit,
            updated: audit,
        }),
        members: memberSessionIds.map((sessionId): GroupMember => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: audit,
            updated: audit,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
        })),
        activeSessions: memberSessionIds.map((sessionId): GroupPresenceSession => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function createAuditStamp(principalId: string): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

function createOverlayInfo(nextHopSessionIds: readonly string[]): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 0,
        },
        provenance: 'server',
        state: 'active',
        overlayId: 'group-1',
        groupRef: groupRef('group-1'),
        topology: 'star',
        name: 'Group 1',
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        nextHopSessionIds,
        degreeLimit: nextHopSessionIds.length,
        overlayVersion: 1,
        updatedAtEpochMs: 1,
    };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
    };
}

function createReadableCache<T>(valuesByKey: Record<string, T>) {
    return {
        read: (key: string) => valuesByKey[key],
        peek: (key: string) => valuesByKey[key],
        hasValue: (key: string) => key in valuesByKey,
        expired: () => false,
        refreshing: () => false,
        has: (key: string) => key in valuesByKey,
        delete: () => false,
        clear: () => undefined,
        clearAll: () => undefined,
        deleteExpired: () => 0,
        size: () => Object.keys(valuesByKey).length,
        keys: function* () {
            for (const key of Object.keys(valuesByKey)) {
                yield key;
            }
        },
        readAllValues: (): Array<Exclude<T, undefined>> =>
            Object.values(valuesByKey).filter(
                (value) => value !== undefined,
            ) as Array<Exclude<T, undefined>>,
    };
}

function createResilienceDto() {
    return shared.ResilienceDto.toResilienceDto(
        new shared.CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
        ),
        1,
        10,
        1,
        1,
    );
}
