import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import type { OutboxRow } from './api-v1-state-write-evidence-contracts.ts';

interface RoomAccessChange {
    readonly commandId: string;
    readonly ref: GroupRef;
    readonly revision: number;
    readonly principalId: string;
}

export interface RoomAccessEvidenceIdentity {
    readonly sourceMessageId: string;
    readonly logicalContextId: string;
    readonly physicalKey: Key;
}

/** Derive the expected private notice from the accepted write, independently of its outbox. */
export function computeRoomAccessEvidenceIdentity({ commandId, ref, revision, principalId }: RoomAccessChange): RoomAccessEvidenceIdentity {
    const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
    const changeId = computeSha256CanonicalJson({ commandId, ref, revision });
    const sourceMessageId = computeSha256CanonicalJson({
        version: 1, resource: 'room-access', scope, groupId: ref.groupId, principalId, changeId
    });
    const logicalContextId = computeSha256CanonicalJson({ scope, principalId });
    const physicalKey = toAppQueueKey({ topicId: AppTopics.viewInvalidated, resourceId: sourceMessageId, contextId: logicalContextId });
    return { sourceMessageId, logicalContextId, physicalKey };
}

export function matchesRoomAccessEffect(row: Omit<OutboxRow, 'ri_status'>, identity: RoomAccessEvidenceIdentity): boolean {
    const key = identity.physicalKey;
    if (row.ri_type_id !== 'WS_OUTBOX' || row.ri_topic_id !== key.topicId ||
        row.ri_resource_id !== key.resourceId || row.fk_ext_bank_id !== key.contextId) return false;
    try {
        const message = decodePersistedALMessage(row.ri_resource);
        return message.id.msgId === identity.sourceMessageId && message.route.resourceId === key.resourceId &&
            message.route.contextId === key.contextId &&
            computeSha256CanonicalJson(decodeViewInvalidationMessage(message)) === identity.sourceMessageId;
    }
    catch {
        return false;
    }
}
