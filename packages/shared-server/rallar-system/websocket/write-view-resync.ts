import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

export interface ViewResyncInput {
    readonly messageId: string;
    readonly createdAtEpochMs: number;
}

/** Re-read authority after LISTEN readiness: existing sockets remain open, and no private identifiers cross scopes. */
export function writeViewResync(service: WsQueueBoxServerService, input: ViewResyncInput): void {
    const message = newALBroadcastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: service.name,
            route: newALRoute(AppTopics.viewResync, input.messageId, 'all'),
            scope: 'all',
            typeId: AppTopics.viewResync,
            resource: { version: 1 }
        }
    );
    service.sendToTargetsWithResult({
        message: { ...message, id: { ...message.id, msgId: input.messageId, ts: input.createdAtEpochMs } },
        sentPositions: null,
        requireAuthenticatedRecipient: true
    });
}
