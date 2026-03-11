import { afterEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { newALMulticastMessage, newALUnicastMessage, } from '@shared/al-contracts/al-contract.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/WebRtcOverlayMulticastService.ts';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

describe('WebRtc overlay services', () => {
    afterEach(() => {
        vi.useRealTimers();
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

        await expect(manager.enqueueIfAbsent(msg)).resolves.toEqual([]);
        expect(connectionService.readPeer).toHaveBeenCalledWith('peer-1');

        const reserved = await queue.reserveEntries(
            new Set([EnqueuedType.RTC_OUTBOX]),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(reserved.size).toBe(0);
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
