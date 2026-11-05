import { type ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALWorldBroadcast } from '../../../al-contracts/is-al-world-broadcast.ts';
import { AppTopics } from '../../../api/api-config.ts';
import {
    hasGroupMoveChangedTopic,
    matchesGroupMoveChangedRecipient
} from '../../../api/mutation/group-move-changed.ts';
import type { StateScope } from '../../../api/state-types.ts';
import { hasViewInvalidatedTopic } from '../../../api/views/view-invalidation.ts';
import type { Key } from '../../../queuebox/ResourceEntry.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    isWsQueueBoxServerDirectWorldBroadcastRow,
    readWsQueueBoxServerScopedTargetScope
} from './requires-ws-queue-box-server-recipient-scope.ts';
import { validateViewInvalidationAudience } from './validate-view-invalidation-authority.ts';

interface ScopedRecipientTargetInput {
    readonly message: ALMessage;
    readonly referenceKey: Key;
    readonly peerId: string;
    readonly connectionId: string;
    readonly scope: StateScope;
    readonly principalTargetId: string | undefined;
}

/** A stored scoped recipient must be the one its row's own target names. */
export function validateScopedRecipientTarget(input: ScopedRecipientTargetInput): readonly string[] {
    const { message, referenceKey, scope, principalTargetId } = input;
    const addressesItsConnection = input.peerId === input.connectionId;
    if (hasGroupMoveChangedTopic(message)) {
        return addressesItsConnection && referenceKey.topicId === AppTopics.groupMoveChanged &&
                matchesGroupMoveChangedRecipient(message, scope, principalTargetId)
            ? []
            : ['Prepared Move Together notice differs from its scoped account and connection'];
    }
    if (hasViewInvalidatedTopic(message)) {
        return addressesItsConnection
            ? validateViewInvalidationAudience(message, scope, principalTargetId)
            : ['Scoped prepared view differs from its connection'];
    }
    if (isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey)) {
        const targetScope = readWsQueueBoxServerScopedTargetScope(message);
        return !targetScope || scope.applicationId !== targetScope.applicationId ||
                scope.workspaceId !== targetScope.workspaceId || !addressesItsConnection ||
                principalTargetId !== undefined
            ? ['Persisted scoped recipient differs from direct broadcast target']
            : [];
    }
    if (isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey)) {
        return message.route.contextId !== scope.applicationId || !addressesItsConnection ||
                principalTargetId !== undefined
            ? ['Persisted scoped recipient differs from direct world target']
            : [];
    }
    if (isALWorldBroadcast(message)) {
        return !addressesItsConnection || principalTargetId !== undefined
            ? ['Persisted scoped recipient differs from world target']
            : [];
    }
    const targets = message.targets;
    if (principalTargetId !== undefined) {
        return referenceKey.topicId === 'AL_OUTBOUND_MESSAGE' || targets?.mode !== 'unicast' ||
                targets.toPeerId !== principalTargetId || message.route.contextId !== principalTargetId ||
                !addressesItsConnection
            ? ['Persisted scoped recipient differs from direct principal target']
            : [];
    }
    return targets?.mode !== 'unicast' || input.peerId !== targets.toPeerId
        ? ['Persisted scoped recipient differs from unicast target']
        : [];
}
