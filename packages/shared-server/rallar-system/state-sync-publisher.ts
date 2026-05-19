import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export type StateSyncPublisher = Readonly<{
    publishClientSnapshot(snapshot: ClientSnapshot, senderId?: string): Promise<void>;
    publishClientEvent(event: ClientEvent, senderId?: string): Promise<void>;
    publishGroupSnapshot(snapshot: GroupSnapshot, senderId?: string): Promise<void>;
    publishGroupEvent(event: GroupEvent, senderId?: string): Promise<void>;
}>;

export type CreateWsStateSyncPublisherOptions = Readonly<{
    serverId: string;
}>;

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
    options: CreateWsStateSyncPublisherOptions,
): StateSyncPublisher {
    return {
        publishClientSnapshot: async (snapshot, senderId) => {
            clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
                snapshot.principal.principalId,
                snapshot,
            );
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.principal.principalId,
                AppTopics.clientStateSnapshot,
                snapshot.principal.principalId,
                snapshot.principal.principalId,
                snapshot,
            );
        },
        publishClientEvent: async (event, senderId) => {
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? event.actor.principalId ?? event.actor.serviceId ?? options.serverId,
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
                event,
            );
        },
        publishGroupSnapshot: async (snapshot, senderId) => {
            groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
            );
        },
        publishGroupEvent: async (event, senderId) => {
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? event.actor.principalId ?? event.actor.serviceId ?? options.serverId,
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
                event,
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
): Promise<void> {
    await wsQBoxServerService.enqueueOutboxIfAbsent(
        newALBroadcastMessage<T>(
            senderId,
            newALEventRoute(topicId, contextId, resourceId),
            'all',
            topicId,
            payload,
        ),
    );
}
