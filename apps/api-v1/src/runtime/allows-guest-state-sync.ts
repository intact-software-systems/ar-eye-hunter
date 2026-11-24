import type { RoomGuestRequest } from '@shared-server/http/room-guest-request.ts';
import { decodeStateSyncMessage } from '@shared-server/rallar-system/state-sync/state-sync-payload.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeStateSnapshotPage, isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';

/** A guest may synchronize the admitted room and its own scoped connection state. */
export function allowsGuestStateSync(message: ALMessage, guest: RoomGuestRequest): boolean {
    const topic = message.route.topicId;
    if (topic === AppTopics.clientStateEvent) {
        const sync = decodeStateSyncMessage(message);
        return sync.kind === 'decoded' && sync.payload.kind === 'client-event' &&
            sync.payload.event.principalId === guest.clientId && sync.payload.event.applicationId === guest.roomRef.applicationId &&
            sync.payload.event.workspaceId === guest.roomRef.workspaceId;
    }
    if (isStateSnapshotTopic(topic)) {
        const page = decodeStateSnapshotPage(message, guest.roomRef).right;
        return !!page && ((page.scope.kind === 'group' && page.scope.resourceId === guest.roomRef.groupId) ||
            (topic === AppTopics.clientStateSnapshot && page.scope.kind === 'principal' &&
                page.scope.resourceId === guest.clientId));
    }
    return false;
}
