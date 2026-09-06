import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as shared from '@shared/mod.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import type { QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

interface CapturedRtcConnection extends shared.WebRtcConnectionService {
    readonly sendByPeerId: ReadonlyMap<string, readonly object[]>;
}

describe('multicast QoS integration', () => {
    afterEach(() => vi.restoreAllMocks());
    it('uses the shared handling planner to produce forwarding copies', () => {
        const connectionService = createConnectionService([
            'peer-1',
            'peer-2',
            'peer-3'
        ]);
        const service = new shared.WebRtcOverlayMulticastService(
            'group-1',
            connectionService
        );
        const msg = {
            ...shared.newALMulticastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.typing.v1',
                {
                    text: 'typing'
                },
                {
                    ttlHops: 2,
                    qos: {
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1
                            }
                        },
                        durability: {
                            algo: 'volatile'
                        }
                    }
                }
            ),
            diagnostics: {
                visitedPeerIds: ['peer-3']
            }
        };

        const plan = service.createForwardingPlan(
            msg,
            createOverlayContext(['self', 'sender-1', 'peer-1', 'peer-2', 'peer-3'], [
                'peer-1',
                'peer-2',
                'peer-3'
            ]),
            { fromPeerId: 'peer-1', qos: undefined }
        );

        expect(plan.handlingPlan.dropReason).toBeUndefined();
        expect(plan.handlingPlan.forwarding.persist).toBe(false);
        expect(plan.handlingPlan.forwarding.nextHopPeerIds).toEqual(['peer-2']);
        expect(plan.handlingPlan.ack.algo).toBe('none');
        expect(plan.transportMessages).toHaveLength(1);
        expect(plan.transportMessages[0].constraints?.ttlHops).toBe(1);
        expect(plan.transportMessages[0].diagnostics?.visitedPeerIds).toEqual([
            'peer-3',
            'self'
        ]);
        expect(plan.transportMessages[0].forwarding?.nextHopPeerIds).toEqual([
            'peer-2'
        ]);
    });

    it('sends volatile multicast immediately instead of queueing it', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.typing.v1',
            {
                text: 'typing'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10
        );

        expect(result.status).toBe('accepted');
        expect(result.entries).toEqual([]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('queues durable multicast so dequeue controls retries', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10
        );

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
        expect(reserved.size).toBe(1);
    });

    it('dequeues durable multicast through the shared outbound runtime', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3b',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello again'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
    });

    it('repairs multicast ack timeouts by rerouting to an alternate parent', async () => {
        vi.useFakeTimers();

        try {
            const connectionService = createConnectionService(['peer-1', 'peer-2']);
            const queue = new shared.InMemoryQueueBox(new Map());
            const manager = new shared.WebRtcOverlayMulticastManager({
                outbox: queue,
                connectionService: connectionService,
                groupCache: createReadableCache({
                    'group-1': createGroupSnapshot(['self', 'peer-1', 'peer-2'])
                }),
                overlayCache: createReadableCache({
                    'group-1': createOverlayInfo(['peer-1', 'peer-2'])
                }),
                multicasterFactory: (overlayId) =>
                    new shared.WebRtcOverlayMulticastService(
                        overlayId,
                        connectionService
                    ),
                qosProvider: undefined,
                outboundDiagnostics: undefined,
                outboundRuntime: createDefaultALOutboundRuntimeResources(),
                circuitBreaker: toCircuitBreaker(),
                rateLimiter: toRateLimiter()
            });

            const msg = shared.newALMulticastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-3c',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.message.v1',
                {
                    text: 'repair via alternate parent'
                },
                {
                    qos: {
                        delivery: {
                            algo: 'at-least-once'
                        },
                        durability: {
                            algo: 'volatile'
                        },
                        ack: {
                            algo: 'hop',
                            opts: {
                                timeoutMs: 100
                            }
                        },
                        retry: {
                            algo: 'exp-backoff',
                            opts: {
                                maxAttempts: 1
                            }
                        },
                        repair: {
                            algo: 'retransmit',
                            opts: {
                                maxRepairs: 1
                            }
                        },
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1
                            }
                        }
                    }
                }
            );

            await manager.enqueueIfAbsent(msg);
            await manager.dequeue(
                shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                createResilienceDto()
            );

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toBeUndefined();

            await vi.advanceTimersByTimeAsync(100);

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(1);
            expect(
                connectionService.sendByPeerId.get('peer-2')?.[0]
            ).toMatchObject({ id: { msgId: msg.id.msgId } });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(['current', 'missing', 'removed'] as const)('requires %s room authority before targeted repair effects', async (authority) => {
        const connectionService = createConnectionService(['peer-1', 'peer-2']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const snapshot = createGroupSnapshot(['self', 'peer-1', 'peer-2']);
        const groups = createReadableCache({ 'group-1': snapshot });
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: groups,
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1', 'peer-2'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3d',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'repair just one peer'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            shared.WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );
        if (authority === 'missing') {
            groups.clearAll();
        }
        else if (authority === 'removed') {
            groups.set('group-1', {
                ...snapshot,
                members: snapshot.members.map((member) =>
                    member.principalId === 'peer-2' && member.status === 'active'
                        ? { ...member, status: 'removed', removed: member.updated }
                        : member
                )
            });
        }
        await manager.acceptControlMessage(
            shared.newALRepairControlMessage(
                { v: 2, msgId: 'repair-control', senderId: 'peer-2', ts: Date.now() },
                { fromPeerId: 'peer-2', toPeerId: 'self', msgId: msg.id.msgId, reason: 'retransmit', observedAtEpochMs: Date.now() }
            )
        );

        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(authority === 'current' ? 2 : 1);
        if (authority === 'current') {
            expect(connectionService.sendByPeerId.get('peer-2')?.[1]).toMatchObject({ id: { msgId: msg.id.msgId } });
        }
        manager.dispose();
    });

    it('sends volatile unicast immediately through the same planning path', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALUnicastMessage(
            'sender-4',
            {
                topicId: 'chat',
                resourceId: 'msg-4',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'private hello'
            }
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10
        );

        expect(result.status).toBe('accepted');
        expect(result.entries).toEqual([]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('does not call raw RTC send when the next-hop channel is not open', async () => {
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': 'connecting'
        });
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALUnicastMessage(
            'sender-4b',
            {
                topicId: 'chat',
                resourceId: 'msg-4b',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'warming hello'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await manager.enqueueIfAbsent(msg);

        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
    });

    it('queues durable unicast when qos requests persistence', async () => {
        const connectionService = createConnectionService(['peer-1']);
        const queue = new shared.InMemoryQueueBox(new Map());
        const manager = new shared.WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = shared.newALUnicastMessage(
            'sender-5',
            {
                topicId: 'chat',
                resourceId: 'msg-5',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'durable hello'
            },
            {
                qos: {
                    delivery: {
                        algo: 'at-least-once'
                    },
                    durability: {
                        algo: 'local-outbox'
                    },
                    ack: {
                        algo: 'hop',
                        opts: {
                            timeoutMs: 1_500
                        }
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 4
                        }
                    }
                }
            }
        );

        const result = await manager.enqueueIfAbsent(msg);
        const reserved = await queue.reserveEntries(
            new Set([shared.EnqueuedType.RTC_OUTBOX]),
            new Set([shared.EntityStatus.NEW]),
            10
        );

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
        expect(reserved.size).toBe(1);
    });
});

function createConnectionService(connectedPeerIds: readonly string[], readyStates: Readonly<Record<string, RTCDataChannelState>> = {}): CapturedRtcConnection {
    const sendByPeerId = new Map<string, object[]>();
    const peers = new Map(connectedPeerIds.map((peerId) => [peerId, createRtcPeer(peerId, readyStates[peerId] ?? 'open', sendByPeerId)]));
    const connectionService = new shared.WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'self',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    vi.spyOn(connectionService, 'readyPeerIdsForLane').mockReturnValue(connectedPeerIds);
    vi.spyOn(connectionService, 'readPeer').mockImplementation((peerId) => peers.get(peerId));
    return Object.assign(connectionService, { sendByPeerId });
}

function createRtcPeer(peerId: string, readyState: RTCDataChannelState, sendByPeerId: Map<string, object[]>): QRtcPeerDto {
    const connection = new shared.QRtcPeerConnection({ send: async () => undefined }, {
        sessionId: 'self',
        peerSessionId: peerId,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    });
    const channel = new shared.QRtcDataChannel(connection, { peerId, dataChannelName: 'test' });
    const health = channel.readHealth();
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...health, readyState });
    vi.spyOn(channel, 'sendJson').mockImplementation((message) => {
        if (typeof message !== 'object' || message === null) {
            throw new Error('Expected an RTC message object');
        }
        const sent = sendByPeerId.get(peerId) ?? [];
        sent.push(message);
        sendByPeerId.set(peerId, sent);
        return { status: 'sent', bufferedAmount: 0 };
    });
    return { peerId, connection, channel, channels: new Map([['reliable', channel]]), media: new shared.QRtcMediaChannel(connection, { peerId }) };
}

function createOverlayContext(
    memberSessionIds: readonly string[],
    nextHopSessionIds: readonly string[]
): shared.OverlayMulticasterContext {
    return {
        nowMs: Date.now(),
        overlayId: 'group-1',
        room: createGroupSnapshot(memberSessionIds),
        overlay: createOverlayInfo(nextHopSessionIds)
    };
}

function createGroupSnapshot(memberSessionIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...groupRef('group-1'), sessionIds: memberSessionIds });
    return { ...snapshot, activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 })) };
}

function createOverlayInfo(nextHopSessionIds: readonly string[]): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 0
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
        updatedAtEpochMs: 1
    };
}

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}

function createReadableCache<T>(valuesByKey: Record<string, T>): LatestRepository<string, T> {
    const cache = new LatestRepository<string, T>();
    for (const [key, value] of Object.entries(valuesByKey)) {
        cache.accept(key, value);
    }
    return cache;
}

function createResilienceDto() {
    return shared.ResilienceDto.toResilienceDto(
        new shared.CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 })
        ),
        1,
        10,
        1,
        1
    );
}
