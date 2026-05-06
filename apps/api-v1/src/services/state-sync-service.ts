import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    createWsStateSyncPublisher as createSharedWsStateSyncPublisher,
    type StateSyncPublisher,
} from '@shared-server/rallar-system/state-sync-publisher.ts';
import { getMiddleware } from '../middleware.ts';
import { myServerId } from '../runtime/runtime-identity.ts';

export type { StateSyncPublisher };

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
): StateSyncPublisher {
    return createSharedWsStateSyncPublisher(wsQBoxServerService, {
        serverId: myServerId,
    });
}

export function getWsStateSyncPublisher(): StateSyncPublisher {
    return createWsStateSyncPublisher(getMiddleware().wsQBoxServerService);
}
