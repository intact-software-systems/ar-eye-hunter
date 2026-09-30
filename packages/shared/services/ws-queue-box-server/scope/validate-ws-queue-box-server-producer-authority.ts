import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { Key } from '../../../queuebox/ResourceEntry.ts';
import type { WsOutboxProducerAuthority } from '../ws-queue-box-server-dequeue-authority.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    isWsQueueBoxServerDirectWorldBroadcastRow,
    requiresWsQueueBoxServerRecipientScope,
    validateWsQueueBoxServerRecipientAuthority
} from './requires-ws-queue-box-server-recipient-scope.ts';

/** The raw rows a producer may write beside its provenance: a scoped unicast, a room, principal or world broadcast. */
export function isWsQueueBoxServerProducerRow(message: ALMessage, referenceKey: Key): boolean {
    return requiresWsQueueBoxServerRecipientScope(message) ||
        isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey) ||
        isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey);
}

export function validateWsQueueBoxServerProducerAuthority(
    message: ALMessage,
    authority: WsOutboxProducerAuthority,
    referenceKey: Key
): readonly string[] {
    const issues = validateWsQueueBoxServerRecipientAuthority(message, authority, referenceKey);
    if (issues.length > 0 || authority.sessionInvalidation !== undefined) {
        return issues;
    }
    if (isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey)) {
        return authority.broadWorld === true
            ? []
            : ['Direct world producer authority is not broad'];
    }
    if (isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey)) {
        return [];
    }
    const targets = message.targets;
    if (targets?.mode !== 'unicast' || authority.admittedAudience === undefined) {
        return ['Producer authority differs from final WS target'];
    }
    return authority.principalTargetId === undefined &&
            authority.admittedAudience.some((peerId) => peerId !== targets.toPeerId)
        ? ['Scoped unicast producer audience names another peer']
        : [];
}
