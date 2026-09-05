import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    newALMulticastMessage,
    newALUnicastMessage,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType, type OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { OverlayMulticasterContext } from '@shared/multicast/overlay-multicast-contracts.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

interface CapturedRtcChannel extends QRtcDataChannel {
    readonly sendCalls: readonly object[][];
}

describe('WebRtc overlay services', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('holds a queued relay until its exact room snapshot catches up again', async () => {
        vi.useFakeTimers();
        const channel = createOpenRtcChannel();
        const connection = createConnectionService(['peer-1', 'peer-2'], { 'peer-2': { channel } });
        const context = createOverlayContext(['self', 'peer-1', 'peer-2'], ['peer-1', 'peer-2']);
        const current = { ...context.room, group: { ...context.room.group, snapshotVersion: 5 } };
        const groups = createReadableCache({ 'group-1': current });
        const manager = new WebRtcOverlayMulticastManager({
            outbox: new InMemoryQueueBox(new Map()),
            connectionService: connection,
            groupCache: groups,
            overlayCache: createReadableCache({ 'group-1': context.overlay }),
            multicasterFactory: (overlayId) => new WebRtcOverlayMulticastService(overlayId, connection),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const message = newALMulticastMessage(
            'peer-1',
            { topicId: 'chat', contextId: 'group-1', resourceId: 'snapshot-forward' },
            groupRef('group-1'),
            'chat.message.v1',
            { text: 'forward only while current' },
            { minSnapshotVersion: 5, ack: 'none', reliability: 'at-least-once' }
        );
        try {
            expect(manager.planIncomingMessage(message, { kind: 'rtc-peer', peerId: 'peer-1' }).dropReason).toBeUndefined();
            expect(await manager.forwardIfRequired(message, 'peer-1')).toHaveLength(1);
            groups.accept('group-1', { ...current, group: { ...current.group, snapshotVersion: 4 } });
            await manager.dequeue(WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES, createResilienceDto());
            expect(channel.sendCalls).toEqual([]);

            groups.accept('group-1', current);
            await vi.advanceTimersByTimeAsync(1_000);
            await manager.dequeue(WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES, createResilienceDto());
            expect(channel.sendCalls).toHaveLength(1);
        }
        finally {
            manager.dispose();
        }
    });

    it('keeps originating multicast copies transport-ready without mutating visited hops or ttl', () => {
        const connectionService = createConnectionService(['peer-1', 'peer-2']);
        const service = new WebRtcOverlayMulticastService(
            'group-1',
            connectionService
        );
        const msg = {
            ...newALMulticastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.message.v1',
                {
                    text: 'hello'
                },
                {
                    ttlHops: 3,
                    qos: {
                        durability: {
                            algo: 'volatile'
                        }
                    }
                }
            ),
            diagnostics: {
                visitedPeerIds: ['peer-z']
            }
        };

        const plan = service.createOriginatingPlan(
            msg,
            createOverlayContext(['self', 'peer-1', 'peer-2'], ['peer-1', 'peer-2'])
        );

        expect(plan.handlingPlan.dropReason).toBeUndefined();
        expect(plan.transportMessages).toHaveLength(2);
        expect(plan.handlingPlan.forwarding.nextHopPeerIds).toEqual([
            'peer-1',
            'peer-2'
        ]);

        for (const transportMessage of plan.transportMessages) {
            expect(transportMessage.constraints?.ttlHops).toBe(3);
            expect(transportMessage.diagnostics?.visitedPeerIds).toEqual(['peer-z']);
            expect(transportMessage.forwarding?.overlayId).toBe('group-1');
            expect(transportMessage.forwarding?.nextHopPeerIds).toHaveLength(1);
        }
    });

    it('skips volatile immediate sends when no rtc channel exists for the planned next hop', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = newALUnicastMessage(
            'sender-2',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'send if present'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: []
        });

        const reserved = await queue.reserveEntries(
            new Set([EnqueuedType.RTC_OUTBOX]),
            new Set([EntityStatus.NEW]),
            10
        );

        expect(reserved.size).toBe(0);
    });

    it('skips outbound messages without targets or next hop', async () => {
        const warnings = captureWarnings();
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALUntargetedMessage(
            'sender-no-targets',
            {
                topicId: 'chat',
                resourceId: 'msg-no-targets',
                contextId: 'conversation-1'
            },
            'chat.private-text.v1',
            {
                text: 'no target'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: []
        });
        expect(warnings).toEqual([]);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('skips multicast sends when overlay context is missing', async () => {
        const warnings = captureWarnings();
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALMulticastMessage(
            'sender-missing-context',
            {
                topicId: 'chat',
                resourceId: 'msg-missing-context',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'missing context'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: []
        });
        expect(warnings).toContain(
            'No GroupSnapshot found for overlayId/groupId group-1'
        );
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('skips multicast sends when no next hop is planned', async () => {
        const warnings = captureWarnings();
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService([]);
        const context = createOverlayContext(['self', 'peer-1'], []);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({ 'group-1': context.room }),
            overlayCache: createReadableCache({ 'group-1': context.overlay }),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-no-next-hop',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'no next hop'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: []
        });
        expect(warnings).toEqual([]);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('resolves multicast room context from target groupRef when group ids collide', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-b'], {
            'peer-b': {
                channel
            }
        });
        const workspaceA = createOverlayContext(
            ['self', 'peer-a'],
            ['peer-a'],
            {
                groupId: 'shared-room',
                workspaceId: 'workspace-a'
            }
        );
        const workspaceB = createOverlayContext(
            ['self', 'peer-b'],
            ['peer-b'],
            {
                groupId: 'shared-room',
                workspaceId: 'workspace-b'
            }
        );
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({
                'shared-room': workspaceA.room,
                'workspace-b-room': workspaceB.room
            }),
            overlayCache: createReadableCache({
                'shared-room': workspaceB.overlay
            }),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-scoped',
                contextId: 'shared-room'
            },
            workspaceB.room.group,
            'chat.message.v1',
            {
                text: 'scoped multicast'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'sent-immediate',
            entries: []
        });
        expect(channel.sendCalls).toHaveLength(1);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('rejects a bare overlay fallback when its groupRef belongs to another workspace', async () => {
        const warnings = captureWarnings();
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-b'], {
            'peer-b': {
                channel
            }
        });
        const workspaceA = createOverlayContext(
            ['self', 'peer-a'],
            ['peer-a'],
            {
                groupId: 'shared-room',
                workspaceId: 'workspace-a'
            }
        );
        const workspaceB = createOverlayContext(
            ['self', 'peer-b'],
            ['peer-b'],
            {
                groupId: 'shared-room',
                workspaceId: 'workspace-b'
            }
        );
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({
                'workspace-a-room': workspaceA.room,
                'workspace-b-room': workspaceB.room
            }),
            overlayCache: createReadableCache({
                'shared-room': {
                    ...workspaceA.overlay,
                    groupRef: workspaceA.room.group
                }
            }),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-cross-workspace-overlay',
                contextId: 'shared-room'
            },
            workspaceB.room.group,
            'chat.message.v1',
            {
                text: 'must not leak'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: []
        });
        expect(channel.sendCalls).toEqual([]);
        expect(warnings).toContainEqual(
            expect.stringContaining('does not match scoped target')
        );
    });

    it('returns no entries for volatile immediate sends even when channel send succeeds', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': {
                channel
            }
        });
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALUnicastMessage(
            'sender-immediate',
            {
                topicId: 'chat',
                resourceId: 'msg-immediate',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'send now'
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'sent-immediate',
            entries: []
        });
        expect(channel.sendCalls).toHaveLength(1);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('rate-limits RTC enqueue attempts before dispatch side effects', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': {
                channel
            }
        });
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: CircuitBreaker.create(createCircuitBreakerPolicy()),
            rateLimiter: RateLimiter.init(1_000, 2)
        });

        const first = await manager.enqueueIfAbsent(
            createUnicastRtcMessage('sender-rate-limit', 'msg-rate-limit-1')
        );
        const second = await manager.enqueueIfAbsent(
            createUnicastRtcMessage('sender-rate-limit', 'msg-rate-limit-2')
        );
        const third = await manager.enqueueIfAbsent(
            createUnicastRtcMessage('sender-rate-limit', 'msg-rate-limit-3')
        );

        expect(first.status).toBe('sent-immediate');
        expect(second.status).toBe('sent-immediate');
        expect(third).toMatchObject({
            status: 'rate-limited',
            entries: [],
            reason: 'RTC enqueue rate limit exceeded'
        });
        expect(channel.sendCalls).toHaveLength(2);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('returns circuit-open without dispatch side effects when the enqueue breaker is open', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': {
                channel
            }
        });
        const circuitBreaker = CircuitBreaker.create(createCircuitBreakerPolicy(1));
        circuitBreaker.failureCount(2);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: circuitBreaker,
            rateLimiter: RateLimiter.init(1_000, 20)
        });

        const result = await manager.enqueueIfAbsent(
            createUnicastRtcMessage('sender-circuit-open', 'msg-circuit-open')
        );

        expect(result).toMatchObject({
            status: 'circuit-open',
            entries: [],
            reason: 'RTC enqueue circuit breaker open'
        });
        expect(channel.sendCalls).toEqual([]);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('does not transmit a malformed persisted AL envelope', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = createOpenRtcChannel();
        const connectionService = createConnectionService(['peer-1'], { 'peer-1': { channel } });
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService,
            groupCache: new LatestRepository(),
            overlayCache: new LatestRepository(),
            multicasterFactory: (overlayId) => new WebRtcOverlayMulticastService(overlayId, connectionService),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const message = createUnicastRtcMessage('sender-corrupt', 'persisted-corrupt');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_OUTBOX);
        await queue.enqueueIfAbsent({
            ...entry,
            resource: JSON.stringify({ ...message, id: { ...message.id, v: 1 }, forwarding: { nextHopPeerIds: ['peer-1'] } })
        });

        await manager.dequeue(WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES, createResilienceDto());

        expect(channel.sendCalls).toEqual([]);
        expect((await queue.getItem(message.route))?.status).not.toBe(EntityStatus.COMPLETED);
        manager.dispose();
    });

    it('returns an outbox entry for durable RTC sends', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALUnicastMessage(
            'sender-durable',
            {
                topicId: 'chat',
                resourceId: 'msg-durable',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me'
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox'
                    }
                }
            }
        );

        const result = await manager.enqueueIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.key.resourceId).toBe('msg-durable');
        expect(await reserveRtcOutbox(queue)).toHaveLength(1);
    });

    it('returns an existing outbox entry when the same durable RTC message is enqueued twice', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALUnicastMessage(
            'sender-duplicate',
            {
                topicId: 'chat',
                resourceId: 'msg-duplicate',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me once'
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox'
                    }
                }
            }
        );

        const firstResult = await manager.enqueueIfAbsent(msg);
        const secondResult = await manager.enqueueIfAbsent(msg);

        expect(firstResult.status).toBe('enqueued');
        expect(firstResult.entries).toHaveLength(1);
        expect(secondResult.status).toBe('duplicate');
        expect(secondResult.entries).toHaveLength(1);
        expect(secondResult.entries[0]?.key.resourceId).toBe('msg-duplicate');
        expect(await reserveRtcOutbox(queue)).toHaveLength(1);
    });

    it('skips expired multicast sends without outbox entries', async () => {
        const warnings = captureWarnings();
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const context = createOverlayContext(['self', 'peer-1'], ['peer-1']);
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({ 'group-1': context.room }),
            overlayCache: createReadableCache({ 'group-1': context.overlay }),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        const msg = newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-expired',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'too late'
            },
            {
                ttlMs: -10_000
            }
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'expired',
            entries: []
        });
        expect(warnings).toEqual([]);
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('keeps durable rtc send effects retryable when dequeue cannot find a channel', async () => {
        vi.useFakeTimers();

        const queue = new InMemoryQueueBox(new Map());
        const peer: { channel: ReturnType<typeof createOpenRtcChannel> | undefined; } = { channel: undefined };
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': peer
        });
        const manager = new WebRtcOverlayMulticastManager({
            outbox: queue,
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources(),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });

        const msg = newALUnicastMessage(
            'sender-3',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'retry me'
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
                            timeoutMs: 1_000
                        }
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 2
                        }
                    }
                }
            }
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        const storedEntry = await queue.getItem(msg.route);

        expect(storedEntry?.status).toBe(EntityStatus.COMPLETED);

        peer.channel = createOpenRtcChannel();
        await vi.advanceTimersByTimeAsync(50);

        expect(peer.channel.sendCalls).toHaveLength(1);
    });
});

async function reserveRtcOutbox(queue: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    return [
        ...(
            await queue.reserveEntries(
                WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                new Set([EntityStatus.NEW]),
                10
            )
        ).values()
    ];
}

function createConnectionService(
    connectedPeerIds: readonly string[],
    peersById: Record<string, { channel: QRtcDataChannel | undefined; }> = {}
): WebRtcConnectionService {
    const connectionService = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'self',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    vi.spyOn(connectionService, 'readyPeerIdsForLane').mockReturnValue(connectedPeerIds);
    vi.spyOn(connectionService, 'readPeer').mockImplementation((peerId) => {
        const channel = peersById[peerId]?.channel;
        if (!channel) {
            return undefined;
        }
        return {
            peerId,
            connection: channel.peerConnection,
            channel,
            channels: new Map([['reliable', channel]]),
            media: new QRtcMediaChannel(channel.peerConnection, { peerId })
        };
    });
    return connectionService;
}

function createOpenRtcChannel(): CapturedRtcChannel {
    const peerConnection = new QRtcPeerConnection({ send: async () => undefined }, {
        sessionId: 'self',
        peerSessionId: 'peer-1',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    });
    const channel = new QRtcDataChannel(peerConnection, { peerId: 'peer-1', dataChannelName: 'test' });
    const health = channel.readHealth();
    const sendCalls: object[][] = [];
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
    vi.spyOn(channel, 'send').mockImplementation(async (message) => {
        sendCalls.push([message]);
    });
    return Object.assign(channel, { sendCalls });
}

function captureWarnings(): string[] {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
        warnings.push(args.map(String).join(' '));
    });
    return warnings;
}

function createUnicastRtcMessage(senderId: string, resourceId: string): ALMessage {
    return newALUnicastMessage(
        senderId,
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1'
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId
        }
    );
}

function createOverlayContext(
    memberSessionIds: readonly string[],
    nextHopSessionIds: readonly string[],
    options: Readonly<{
        groupId?: string;
        applicationId?: string;
        workspaceId?: string;
    }> = {}
): OverlayMulticasterContext {
    const applicationId = options.applicationId ?? 'app-1';
    const workspaceId = options.workspaceId ?? 'workspace-1';
    const groupId = options.groupId ?? 'group-1';

    const room = createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds: memberSessionIds
    });
    const overlay: OverlayInfo = {
        sourceGroupStateCausalRevision: room.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: groupId,
        groupRef: room.group,
        topology: 'tree',
        name: 'Group 1',
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        nextHopSessionIds,
        degreeLimit: Math.max(1, nextHopSessionIds.length),
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };

    return {
        nowMs: Date.now(),
        overlayId: groupId,
        room: { ...room, activeSessions: room.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 })) },
        overlay
    };
}

function createReadableCache<T>(valuesByKey: Record<string, T>): LatestRepository<string, T> {
    const cache = new LatestRepository<string, T>();
    for (const [key, value] of Object.entries(valuesByKey)) {
        cache.accept(key, value);
    }
    return cache;
}

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}

function createCircuitBreakerPolicy(maxConsecutiveFailures: number = 10) {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return new CircuitBreakerPolicy(
        maxConsecutiveFailures,
        duration,
        duration,
        duration
    );
}

function createResilienceDto() {
    return ResilienceDto.toResilienceDto(
        createCircuitBreakerPolicy(),
        1,
        10,
        1,
        1
    );
}
