import { afterEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    newALMulticastMessage,
    newALUnicastMessage,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/WebRtcOverlayMulticastService.ts';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

describe('WebRtc overlay services', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps originating multicast copies transport-ready without mutating visited hops or ttl', () => {
        const connectionService = createConnectionService(['peer-1', 'peer-2']);
        const service = new WebRtcOverlayMulticastService(
            'group-1',
            connectionService as never,
        );
        const msg = {
            ...newALMulticastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'group-1',
                },
                'group-1',
                'chat.message.v1',
                {
                    text: 'hello',
                },
                {
                    ttlHops: 3,
                    qos: {
                        durability: {
                            algo: 'volatile',
                        },
                    },
                },
            ),
            diagnostics: {
                visitedPeerIds: ['peer-z'],
            },
        };

        const plan = service.createOriginatingPlan(
            msg,
            createOverlayContext(['self', 'peer-1', 'peer-2'], ['peer-1', 'peer-2']),
        );

        expect(plan.handlingPlan.dropReason).toBeUndefined();
        expect(plan.transportMessages).toHaveLength(2);
        expect(plan.handlingPlan.forwarding.nextHopPeerIds).toEqual([
            'peer-1',
            'peer-2',
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
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = newALUnicastMessage(
            'sender-2',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'send if present',
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: [],
        });
        expect(connectionService.readPeer).toHaveBeenCalledWith('peer-1');

        const reserved = await queue.reserveEntries(
            new Set([EnqueuedType.RTC_OUTBOX]),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(reserved.size).toBe(0);
    });

    it('skips outbound messages without targets or next hop', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALUntargetedMessage(
            'sender-no-targets',
            {
                topicId: 'chat',
                resourceId: 'msg-no-targets',
                contextId: 'conversation-1',
            },
            'chat.private-text.v1',
            {
                text: 'no target',
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: [],
        });
        expect(warn).not.toHaveBeenCalled();
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('skips multicast sends when overlay context is missing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALMulticastMessage(
            'sender-missing-context',
            {
                topicId: 'chat',
                resourceId: 'msg-missing-context',
                contextId: 'group-1',
            },
            'group-1',
            'chat.message.v1',
            {
                text: 'missing context',
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: [],
        });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(
            'No GroupSnapshot found for overlayId/groupId group-1',
        );
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('skips multicast sends when no next hop is planned', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService([]);
        const context = createOverlayContext(['self', 'peer-1'], []);
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({ 'group-1': context.room }),
            createReadableCache({ 'group-1': context.overlay }),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALMulticastMessage(
            'sender-no-next-hop',
            {
                topicId: 'chat',
                resourceId: 'msg-no-next-hop',
                contextId: 'group-1',
            },
            'group-1',
            'chat.message.v1',
            {
                text: 'no next hop',
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'no-route',
            entries: [],
        });
        expect(warn).not.toHaveBeenCalled();
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('returns no entries for volatile immediate sends even when channel send succeeds', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const channel = {
            send: vi.fn(async () => Promise.resolve()),
        };
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': {
                channel,
            },
        });
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALUnicastMessage(
            'sender-immediate',
            {
                topicId: 'chat',
                resourceId: 'msg-immediate',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'send now',
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'sent-immediate',
            entries: [],
        });
        expect(channel.send).toHaveBeenCalledOnce();
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('returns an outbox entry for durable RTC sends', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALUnicastMessage(
            'sender-durable',
            {
                topicId: 'chat',
                resourceId: 'msg-durable',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me',
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox',
                    },
                },
            },
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
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALUnicastMessage(
            'sender-duplicate',
            {
                topicId: 'chat',
                resourceId: 'msg-duplicate',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me once',
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox',
                    },
                },
            },
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
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const queue = new InMemoryQueueBox(new Map());
        const connectionService = createConnectionService(['peer-1']);
        const context = createOverlayContext(['self', 'peer-1'], ['peer-1']);
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({ 'group-1': context.room }),
            createReadableCache({ 'group-1': context.overlay }),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );
        const msg = newALMulticastMessage(
            'sender-expired',
            {
                topicId: 'chat',
                resourceId: 'msg-expired',
                contextId: 'group-1',
            },
            'group-1',
            'chat.message.v1',
            {
                text: 'too late',
            },
            {
                ttlMs: -10_000,
            },
        );

        await expect(manager.enqueueIfAbsent(msg)).resolves.toMatchObject({
            status: 'expired',
            entries: [],
        });
        expect(warn).not.toHaveBeenCalled();
        expect(await reserveRtcOutbox(queue)).toHaveLength(0);
    });

    it('keeps durable rtc send effects retryable when dequeue cannot find a channel', async () => {
        vi.useFakeTimers();

        const queue = new InMemoryQueueBox(new Map());
        const peer = {} as { channel?: { send: ReturnType<typeof vi.fn> } };
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': peer,
        });
        const manager = new WebRtcOverlayMulticastManager(
            queue,
            connectionService as never,
            createReadableCache({}),
            createReadableCache({}),
            (overlayId) =>
                new WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService as never,
                ),
        );

        const msg = newALUnicastMessage(
            'sender-3',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'retry me',
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
                            timeoutMs: 1_000,
                        },
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 2,
                        },
                    },
                },
            },
        );

        await manager.enqueueIfAbsent(msg);
        await manager.dequeue(
            WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        const storedEntry = [
            ...((queue as unknown as { data: Map<string, ResourceEntry> }).data
                .values()),
        ][0];

        expect(connectionService.readPeer).toHaveBeenCalledWith('peer-1');
        expect(storedEntry.status).toBe(EntityStatus.COMPLETED);

        peer.channel = {
            send: vi.fn(async () => Promise.resolve()),
        };
        await vi.advanceTimersByTimeAsync(50);

        expect(peer.channel.send).toHaveBeenCalledOnce();
    });
});

async function reserveRtcOutbox(queue: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    return [
        ...(
            await queue.reserveEntries(
                WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                new Set([EntityStatus.NEW]),
                10,
            )
        ).values(),
    ];
}

function createConnectionService(
    connectedPeerIds: readonly string[],
    peersById: Record<string, unknown> = {},
) {
    return {
        input: {
            sessionId: 'self',
        },
        connectedPeerIds: () => [...connectedPeerIds],
        readPeer: vi.fn((peerId: string) => peersById[peerId]),
    };
}

function createOverlayContext(
    memberSessionIds: readonly string[],
    nextHopSessionIds: readonly string[],
) {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        overlayId: 'group-1',
        room: {
            group: {
                applicationId,
                workspaceId,
                groupId: 'group-1',
                displayName: 'Group 1',
                kind: 'room',
                status: 'active',
                joinMode: 'open',
                metadata: {},
                metadataVersion: 0,
                rosterVersion: 1,
                presenceVersion: 0,
                created: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
                updated: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
            },
            members: memberSessionIds.map((sessionId) => ({
                applicationId,
                workspaceId,
                groupId: 'group-1',
                principalId: sessionId,
                role: 'member',
                status: 'active',
                joined: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
                updated: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
            })),
            activeSessions: memberSessionIds.map((sessionId) => ({
                applicationId,
                workspaceId,
                groupId: 'group-1',
                sessionId,
                principalId: sessionId,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: 60_001,
            })),
            memberCount: memberSessionIds.length,
            onlineMemberCount: memberSessionIds.length,
        },
        overlay: {
            overlayId: 'group-1',
            name: 'Group 1',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds,
            overlayVersion: 1,
            updatedAtEpochMs: 1,
        },
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
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(
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
