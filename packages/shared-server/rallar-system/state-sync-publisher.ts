import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    recordRallarTiming,
    type RallarTimingSink,
} from './services/timing.ts';

export type StateSyncPublisher = Readonly<{
    publishClientSnapshot(
        snapshot: ClientSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
    publishClientEvent(
        event: ClientEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
    publishGroupSnapshot(
        snapshot: GroupSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
    publishGroupEvent(
        event: GroupEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
}>;

export type CreateWsStateSyncPublisherOptions = Readonly<{
    serverId: string;
    timing?: RallarTimingSink;
}>;

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
    options: CreateWsStateSyncPublisherOptions,
): StateSyncPublisher {
    return {
        publishClientSnapshot: async (snapshot, senderId, deliveryId) => {
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.principal.principalId,
                AppTopics.clientStateSnapshot,
                snapshot.principal.principalId,
                snapshot.principal.principalId,
                snapshot,
                {
                    requireLiveRoute: hasActiveClientSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
        publishClientEvent: async (event, senderId, deliveryId) => {
            const snapshot = clientStateSnapshotsRepository
                .findClientStateSnapshotByPrincipalId(event.principalId);
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? event.actor.principalId ?? event.actor.serviceId ?? options.serverId,
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveClientSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
        publishGroupSnapshot: async (snapshot, senderId, deliveryId) => {
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    requireLiveRoute: hasActiveGroupSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupDirectorySnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
        publishGroupEvent: async (event, senderId, deliveryId) => {
            const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
                {
                    applicationId: event.applicationId,
                    workspaceId: event.workspaceId,
                    groupId: event.groupId,
                },
            );
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? event.actor.principalId ?? event.actor.serviceId ?? options.serverId,
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveGroupSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
    };
}

async function enqueueBroadcast<T>(
    wsQBoxServerService: WsQueueBoxServerService,
    senderId: string,
    topicId: string,
    contextId: string,
    resourceId: string,
    payload: T,
    options: Readonly<{
        requireLiveRoute?: boolean;
        timing?: RallarTimingSink;
        deliveryId?: string;
    }> = {},
): Promise<void> {
    const message = newALBroadcastMessage<T>(
        senderId,
        newALEventRoute(topicId, contextId, resourceId),
        'all',
        topicId,
        payload,
    );
    const result = await wsQBoxServerService.enqueueOutboxIfAbsent(
        options.deliveryId
            ? {
                ...message,
                id: {
                    ...message.id,
                    msgId: toStateSyncMessageId(options.deliveryId, topicId),
                },
            }
            : message,
    );

    assertStateSyncPublishResult(result, {
        topicId,
        resourceId,
        requireLiveRoute: options.requireLiveRoute ?? false,
        timing: options.timing,
    });
}

export function toStateSyncMessageId(
    deliveryId: string,
    topicId: string,
): string {
    return `state-sync-${fnv1a64(`${deliveryId}\u0000${topicId}`)}`;
}

function assertStateSyncPublishResult(
    result: ALOutboundEnqueueResult,
    input: Readonly<{
        topicId: string;
        resourceId: string;
        requireLiveRoute: boolean;
        timing?: RallarTimingSink;
    }>,
): void {
    switch (result.status) {
        case 'enqueued':
        case 'sent-immediate':
        case 'duplicate':
            return;
        case 'skipped':
        case 'superseded':
        case 'expired':
            if (!input.requireLiveRoute) {
                return;
            }
            break;
        case 'no-route':
            if (input.requireLiveRoute) {
                console.warn('State sync publish missed live route', {
                    topicId: input.topicId,
                    resourceId: input.resourceId,
                    status: result.status,
                    reason: result.reason,
                });
                recordRallarTiming(
                    input.timing,
                    {
                        component: 'state-sync',
                        operation: 'no-route',
                        details: {
                            topicId: input.topicId,
                            resourceId: input.resourceId,
                            reason: result.reason,
                        },
                    },
                    'ok',
                    0,
                );
            }
            return;
        case 'failed':
        case 'rate-limited':
        case 'circuit-open':
            break;
    }

    throw new Error(
        `State sync publish failed for ${input.topicId}/${input.resourceId}: ${result.status}` +
        (result.reason ? ` (${result.reason})` : ''),
    );
}

function hasActiveClientSessions(snapshot: ClientSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.activeSessionCount > 0 ||
        snapshot.isOnline;
}

function hasActiveGroupSessions(snapshot: GroupSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.onlineMemberCount > 0;
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(36);
}
