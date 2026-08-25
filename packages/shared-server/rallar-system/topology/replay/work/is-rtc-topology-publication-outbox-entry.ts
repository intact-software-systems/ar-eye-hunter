import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

export function isRtcTopologyPublicationOutboxEntry(entry: ResourceEntry): boolean {
    try {
        const value = JSON.parse(entry.resource);
        validatePersistedALMessage(value);
        const message = value as ALMessage;
        const targets = message.targets;
        const expiresAtMs = message.constraints?.expiresAtMs;
        if (
            entry.typeId !== EnqueuedType.WS_OUTBOX ||
            message.id.senderId !== 'rallar-server' ||
            message.route.topicId !== AppTopics.overlayTopology ||
            message.payload.typeId !== AppTopics.overlayTopology ||
            message.payload.contentType !== 'application/json' ||
            targets?.mode !== 'broadcast' ||
            targets.scope !== 'room' ||
            targets.groupRef === undefined ||
            targets.recipientPeerIds === undefined ||
            message.audit?.createdBy !== 'rallar-server' ||
            message.audit.createdTs !== message.id.ts ||
            !Number.isSafeInteger(expiresAtMs) ||
            expiresAtMs === undefined ||
            entry.audit.createdBy !== toAppQueueCreatedBy(message.audit.createdBy) ||
            entry.audit.expiryTs.epochMilliseconds !== expiresAtMs ||
            !isKeysEqual(
                entry.key,
                toAppQueueKey({
                    topicId: message.route.topicId,
                    resourceId: message.id.msgId,
                    contextId: message.route.contextId
                })
            )
        ) {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
