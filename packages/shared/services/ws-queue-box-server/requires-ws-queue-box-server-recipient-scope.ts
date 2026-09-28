import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import {
    validateALOutboundRecipientScope,
    type ALOutboundCapturedPolicy
} from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';

/** Only a fully decoded AL control envelope is exempt from public recipient scope. */
export function requiresWsQueueBoxServerRecipientScope(message: ALMessage): boolean {
    return message.targets?.mode === 'unicast' && decodeALControlMessage(message).right === undefined;
}

/** Classification only: callers must first verify producer proof or the exact stored admission. */
export function isWsQueueBoxServerDirectRoomRow(message: ALMessage, referenceKey: Key | undefined): boolean {
    return referenceKey !== undefined && referenceKey.topicId !== 'AL_OUTBOUND_MESSAGE' &&
        message.targets?.mode === 'broadcast' && message.targets.scope === 'room';
}

/** Initial dispatch and repair apply the same captured recipient authority rules. */
export function validateWsQueueBoxServerRecipientAuthority(
    message: ALMessage,
    authority: Pick<ALOutboundCapturedPolicy, 'admittedAudience' | 'recipientScope'>,
    referenceKey: Key | undefined
): readonly string[] {
    if (isWsQueueBoxServerDirectRoomRow(message, referenceKey)) {
        return validateWsQueueBoxServerDirectRoomAuthority(message, authority);
    }
    return requiresWsQueueBoxServerRecipientScope(message)
        ? validateALOutboundRecipientScope(authority.recipientScope)
        : [];
}

export function validateWsQueueBoxServerDirectRoomAuthority(
    message: ALMessage,
    authority: Pick<ALOutboundCapturedPolicy, 'admittedAudience' | 'recipientScope'>
): readonly string[] {
    const targets = message.targets;
    const scope = authority.recipientScope;
    if (validateALOutboundRecipientScope(scope).length > 0 || authority.admittedAudience === undefined) {
        return ['Direct room row has no frozen scoped audience'];
    }
    if (
        targets?.mode !== 'broadcast' || targets.scope !== 'room' || !targets.groupRef ||
        targets.groupRef.applicationId !== scope?.applicationId || targets.groupRef.workspaceId !== scope.workspaceId
    ) {
        return ['Direct room row scope differs from captured authority'];
    }
    return [];
}
