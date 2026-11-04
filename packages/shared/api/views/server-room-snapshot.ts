import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { AppTopics } from '../api-config.ts';
import type { StateScope } from '../state-types.ts';

export interface ServerRoomSnapshotProducer {
    readonly producerId: string;
    readonly scope: StateScope;
}

export function hasServerRoomSnapshotTopic(message: ALMessage): boolean {
    return message.route.topicId === AppTopics.serverRoomSnapshot ||
        message.payload.typeId === AppTopics.serverRoomSnapshot;
}

/** Generic nodes can validate the frozen producer and room without knowing the application's compressed frame. */
export function isServerRoomSnapshotMessage(
    message: ALMessage,
    producer: ServerRoomSnapshotProducer | undefined
): boolean {
    const target = message.targets;
    if (!producer || target?.mode !== 'broadcast' || target.scope !== 'room' || !target.groupRef) {
        return false;
    }
    const room = target.groupRef;
    return message.route.topicId === AppTopics.serverRoomSnapshot &&
        message.payload.typeId === AppTopics.serverRoomSnapshot &&
        message.id.senderId === producer.producerId && producer.producerId.length > 0 &&
        room.applicationId === producer.scope.applicationId && room.workspaceId === producer.scope.workspaceId &&
        target.principalRef === undefined && target.exceptPeerIds === undefined &&
        target.recipientPeerIds === undefined &&
        target.minSnapshotVersion === undefined && target.rosterVersion === undefined &&
        message.route.contextId === toAppQueueKey({ ...message.route, contextId: room.groupId }).contextId &&
        Number.isSafeInteger(message.constraints?.expiresAtMs);
}
