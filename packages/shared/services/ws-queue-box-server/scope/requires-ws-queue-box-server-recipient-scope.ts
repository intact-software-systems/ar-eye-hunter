import { isALWorldBroadcast, type ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';
import type { ALOutboundCapturedPolicy } from '../../../alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    resolveALOutboundScopeAuthority,
    type ALOutboundScopeAuthority
} from '../../../alm/outbound/admission/al-outbound-scope-authority.ts';
import { validateALSessionInvalidationMessage } from '../../../alm/outbound/admission/al-session-invalidation-authority.ts';
import type { StateScope } from '../../../api/state-types.ts';
import type { Key } from '../../../queuebox/ResourceEntry.ts';

/** A unicast that names no group needs the scope its producer proved; a fully decoded AL control envelope is exempt. */
export function requiresWsQueueBoxServerRecipientScope(message: ALMessage): boolean {
    return message.targets?.mode === 'unicast' && message.targets.groupRef === undefined &&
        decodeALControlMessage(message).right === undefined;
}

/** Classification only: callers must first verify producer proof or the exact stored admission. */
export function isWsQueueBoxServerDirectScopedBroadcastRow(
    message: ALMessage,
    referenceKey: Key | undefined
): boolean {
    return referenceKey !== undefined && referenceKey.topicId !== 'AL_OUTBOUND_MESSAGE' &&
        message.targets?.mode === 'broadcast' &&
        (message.targets.scope === 'room' || message.targets.scope === 'principal');
}

export function isWsQueueBoxServerDirectWorldBroadcastRow(
    message: ALMessage,
    referenceKey: Key | undefined
): boolean {
    return referenceKey !== undefined && referenceKey.topicId !== 'AL_OUTBOUND_MESSAGE' &&
        message.targets?.mode === 'broadcast' && message.targets.scope === 'world';
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

/** Planning, repair, first dequeue and cluster delivery apply the same recipient authority rules. */
export function validateWsQueueBoxServerRecipientAuthority(
    message: ALMessage,
    authority: Pick<
        ALOutboundCapturedPolicy,
        'admittedAudience' | 'recipientScope' | 'principalTargetId' | 'sessionInvalidation'
    >,
    referenceKey: Key | undefined
): readonly string[] {
    const resolved = resolveALOutboundScopeAuthority(message, authority);
    if (resolved.left) {
        return resolved.left;
    }
    const scope = resolved.right!;
    switch (scope.kind) {
        case 'session-invalidation':
            return authority.admittedAudience?.length === 1 &&
                    authority.admittedAudience[0] === scope.sessionInvalidation.sessionId
                ? validateALSessionInvalidationMessage(message, scope.sessionInvalidation)
                : ['Session invalidation must name only its exact session'];
        case 'group-ref':
            return isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey) &&
                    authority.admittedAudience === undefined
                ? ['Direct broadcast row has no frozen scoped audience']
                : [];
        case 'recipient-scope':
            return validateWsQueueBoxServerScopedRowAuthority({
                message,
                scope,
                admittedAudience: authority.admittedAudience,
                referenceKey
            });
        case 'none':
            return requiresWsQueueBoxServerRecipientScope(message) ||
                    isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey) ||
                    isALWorldBroadcast(message)
                ? ['Public WS unicast and world broadcast require explicit application and workspace scope']
                : [];
    }
}

interface ValidateWsQueueBoxServerScopedRowAuthorityInput {
    readonly message: ALMessage;
    readonly scope: Extract<ALOutboundScopeAuthority, { kind: 'recipient-scope'; }>;
    readonly admittedAudience: readonly string[] | undefined;
    readonly referenceKey: Key | undefined;
}

function validateWsQueueBoxServerScopedRowAuthority(
    input: ValidateWsQueueBoxServerScopedRowAuthorityInput
): readonly string[] {
    const { message, scope, admittedAudience, referenceKey } = input;
    if (isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey)) {
        return validateWsQueueBoxServerDirectPrincipalBroadcastAuthority(
            message,
            scope,
            admittedAudience
        );
    }
    if (isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey)) {
        return admittedAudience === undefined && scope.principalTargetId === undefined
            ? []
            : ['Direct world broadcast has no scoped subscriber-local authority'];
    }
    if (scope.principalTargetId === undefined) {
        return [];
    }
    return message.targets?.mode === 'unicast' &&
            message.targets.toPeerId === scope.principalTargetId &&
            message.route.contextId === scope.principalTargetId && admittedAudience !== undefined
        ? []
        : ['Principal target differs from captured scoped audience'];
}

function validateWsQueueBoxServerDirectPrincipalBroadcastAuthority(
    message: ALMessage,
    scope: Extract<ALOutboundScopeAuthority, { kind: 'recipient-scope'; }>,
    admittedAudience: readonly string[] | undefined
): readonly string[] {
    const targets = message.targets;
    const principalRef = targets?.mode === 'broadcast' && targets.scope === 'principal'
        ? targets.principalRef
        : undefined;
    if (
        admittedAudience === undefined || scope.principalTargetId !== undefined ||
        principalRef === undefined
    ) {
        return ['Direct broadcast row has no frozen scoped audience'];
    }
    return principalRef.applicationId === scope.recipientScope.applicationId &&
            principalRef.workspaceId === scope.recipientScope.workspaceId
        ? []
        : ['Direct broadcast row scope differs from captured authority'];
}
