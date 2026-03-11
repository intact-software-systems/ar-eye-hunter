import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { newALBroadcastMessage, newALEventRoute, } from '@shared/al-contracts/al-contract.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { getMiddleware } from '../middleware.ts';
import { myServerId } from '../config-repo.ts';

export type StateSyncPublisher = Readonly<{
    publishClientSnapshot(
        snapshot: ClientSnapshot,
        senderId?: string,
    ): Promise<void>;
    publishClientEvent(event: ClientEvent, senderId?: string): Promise<void>;
    publishGroupSnapshot(
        snapshot: GroupSnapshot,
        senderId?: string,
    ): Promise<void>;
    publishGroupEvent(event: GroupEvent, senderId?: string): Promise<void>;
}>;

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
): StateSyncPublisher {
    return {
        publishClientSnapshot: async (snapshot, senderId) => {
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
                senderId ?? event.actor.principalId ?? event.actor.serviceId ??
                myServerId,
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
                event,
            );
        },
        publishGroupSnapshot: async (snapshot, senderId) => {
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
                senderId ?? event.actor.principalId ?? event.actor.serviceId ??
                myServerId,
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
                event,
            );
        },
    };
}

export function getWsStateSyncPublisher(): StateSyncPublisher {
    return createWsStateSyncPublisher(getMiddleware().wsQBoxServerService);
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
