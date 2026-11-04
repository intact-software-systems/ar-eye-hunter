import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { AppTopics } from '../api-config.ts';
import { requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import type { StateScope } from '../state-types.ts';
import { decodeGroupMoveClaim, moveIdentifier, type GroupMoveClaim } from './decode-group-move.ts';

/** An account-owned history hint; cohort consent and arrival remain bound to the original participant sessions. */
export function decodeGroupMoveChangedMessage(message: ALMessage): GroupMoveClaim {
    if (message.route.topicId !== AppTopics.groupMoveChanged || message.payload.typeId !== AppTopics.groupMoveChanged) {
        throw new TypeError('Group move change topic and type differ');
    }
    const claim = decodeGroupMoveClaim(JSON.parse(message.payload.resource));
    const targets = requireRecord(message.targets, 'Group move targets');
    requireExactKeys(targets, ['mode', 'scope', 'principalRef'], 'Group move targets');
    const principal = requireRecord(targets.principalRef, 'Group move principal');
    requireExactKeys(principal, ['applicationId', 'workspaceId', 'principalId'], 'Group move principal');
    moveIdentifier(principal.principalId);
    const { source } = claim;
    const contextId = `app=${encodeURIComponent(source.applicationId)}:ws=${
        encodeURIComponent(source.workspaceId)
    }:group=${encodeURIComponent(source.groupId)}`;
    if (
        targets.mode !== 'broadcast' || targets.scope !== 'principal' ||
        principal.applicationId !== source.applicationId || principal.workspaceId !== source.workspaceId ||
        message.route.contextId !== toAppQueueKey({ ...message.route, contextId }).contextId
    ) {
        throw new TypeError('Group move claim differs from its exact source scope and account target');
    }
    return claim;
}

export function hasGroupMoveChangedTopic(message: ALMessage): boolean {
    return message.route.topicId === AppTopics.groupMoveChanged ||
        message.payload.typeId === AppTopics.groupMoveChanged;
}

export function matchesGroupMoveChangedRecipient(
    message: ALMessage,
    scope: StateScope | undefined,
    principalId: string | undefined
): boolean {
    try {
        const claim = decodeGroupMoveChangedMessage(message);
        return message.targets?.mode === 'broadcast' && message.targets.scope === 'principal' &&
            message.targets.principalRef?.principalId === principalId &&
            scope?.applicationId === claim.source.applicationId &&
            scope.workspaceId === claim.source.workspaceId;
    }
    catch {
        return false;
    }
}
