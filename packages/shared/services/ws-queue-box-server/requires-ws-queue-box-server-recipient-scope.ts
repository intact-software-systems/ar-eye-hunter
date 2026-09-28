import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import {
    validateALOutboundRecipientScope,
    type ALOutboundCapturedPolicy
} from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';

/** Only a fully decoded AL control envelope is exempt from public recipient scope. */
export function requiresWsQueueBoxServerRecipientScope(message: ALMessage): boolean {
    return message.targets?.mode === 'unicast' && decodeALControlMessage(message).right === undefined;
}

/** Classification only: callers must first verify producer proof or the exact stored admission. */
export function isWsQueueBoxServerDirectScopedBroadcastRow(message: ALMessage, referenceKey: Key | undefined): boolean {
    return referenceKey !== undefined && referenceKey.topicId !== 'AL_OUTBOUND_MESSAGE' &&
        message.targets?.mode === 'broadcast' &&
        (message.targets.scope === 'room' || message.targets.scope === 'principal');
}

export function readWsQueueBoxServerScopedTargetScope(message: ALMessage): StateScope | undefined {
    const targets = message.targets;
    if (targets?.mode === 'multicast') {
        return targets.groupRef;
    }
    if (targets?.mode !== 'broadcast') {
        return undefined;
    }
    if (targets.scope === 'room') {
        return targets.groupRef;
    }
    if (targets.scope === 'principal') {
        return targets.principalRef;
    }
    return undefined;
}

/** Initial dispatch and repair apply the same captured recipient authority rules. */
export function validateWsQueueBoxServerRecipientAuthority(
    message: ALMessage,
    authority: Pick<ALOutboundCapturedPolicy, 'admittedAudience' | 'recipientScope'>,
    referenceKey: Key | undefined
): readonly string[] {
    if (isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey)) {
        return validateWsQueueBoxServerDirectScopedBroadcastAuthority(message, authority);
    }
    return requiresWsQueueBoxServerRecipientScope(message)
        ? validateALOutboundRecipientScope(authority.recipientScope)
        : [];
}

export function validateWsQueueBoxServerDirectScopedBroadcastAuthority(
    message: ALMessage,
    authority: Pick<ALOutboundCapturedPolicy, 'admittedAudience' | 'recipientScope'>
): readonly string[] {
    const scope = authority.recipientScope;
    if (validateALOutboundRecipientScope(scope).length > 0 || authority.admittedAudience === undefined) {
        return ['Direct broadcast row has no frozen scoped audience'];
    }
    if (message.targets?.mode !== 'broadcast') {
        return ['Direct broadcast row target is not a broadcast'];
    }
    const targetScope = readWsQueueBoxServerScopedTargetScope(message);
    if (
        !targetScope || targetScope.applicationId !== scope?.applicationId ||
        targetScope.workspaceId !== scope.workspaceId
    ) {
        return ['Direct broadcast row scope differs from captured authority'];
    }
    return [];
}
