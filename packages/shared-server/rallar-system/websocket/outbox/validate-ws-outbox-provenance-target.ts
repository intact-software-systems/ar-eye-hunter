import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validateALAccountViewMessage } from '@shared/alm/outbound/admission/al-account-view-authority.ts';
import { validateALSessionInvalidationMessage } from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { hasGroupMoveChangedTopic, matchesGroupMoveChangedRecipient } from '@shared/api/mutation/group-move-changed.ts';
import { requiresWsQueueBoxServerRecipientScope } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';

import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';

import type { WsOutboxProvenance } from './ws-outbox-provenance.ts';

export function validateWsOutboxProvenanceTarget(
    message: ALMessage,
    target: WsOutboxProvenance['target']
): readonly string[] {
    if (target.kind === 'account-view') {
        return validateALAccountViewMessage(message, target.accountView);
    }
    if (target.kind === 'exact-invalidated-session') {
        return validateALSessionInvalidationMessage(message, target.sessionInvalidation);
    }
    const targets = message.targets;
    if (target.kind === 'scoped-world-broadcast') {
        return validateWorldTarget(message, target);
    }
    if (target.kind === 'scoped-principal-unicast') {
        return targets?.mode === 'unicast' && targets.toPeerId === target.peerId &&
                message.route.contextId === target.principalRef.principalId
            ? []
            : ['WS provenance target differs from scoped principal identity'];
    }
    if (target.kind === 'scoped-room-broadcast') {
        return targets?.mode === 'broadcast' && targets.scope === 'room' && targets.groupRef &&
                isSameGroupRef(targets.groupRef, target.groupRef)
            ? []
            : ['WS provenance target differs from scoped room identity'];
    }
    if (target.kind === 'scoped-account-view') {
        return validateAccountViewTarget(message, target);
    }
    if (target.kind === 'scoped-principal-broadcast') {
        const principalRef = targets?.mode === 'broadcast' && targets.scope === 'principal'
            ? targets.principalRef
            : undefined;
        const groupRef = readALTargetGroupRef(message);
        return principalRef?.applicationId === target.principalRef.applicationId &&
                principalRef.workspaceId === target.principalRef.workspaceId &&
                principalRef.principalId === target.principalRef.principalId &&
                (groupRef === undefined || (
                    groupRef.applicationId === principalRef.applicationId &&
                    groupRef.workspaceId === principalRef.workspaceId
                ))
            ? []
            : ['WS provenance target differs from scoped principal identity'];
    }
    return targets?.mode === 'unicast' && requiresWsQueueBoxServerRecipientScope(message) &&
            targets.toPeerId === target.peerId && target.admittedAudience.every((peerId) => peerId === target.peerId)
        ? []
        : ['WS provenance target differs from public unicast identity'];
}

function validateAccountViewTarget(
    message: ALMessage,
    target: Extract<WsOutboxProvenance['target'], { kind: 'scoped-account-view'; }>
): readonly string[] {
    if (hasGroupMoveChangedTopic(message)) {
        return matchesGroupMoveChangedRecipient(message, target.principalRef, target.principalRef.principalId)
            ? []
            : ['Move Together claim differs from its scoped account provenance'];
    }
    try {
        const notice = decodeViewInvalidationMessage(message);
        return notice.scope !== null && notice.principalId === target.principalRef.principalId &&
                notice.scope.applicationId === target.principalRef.applicationId &&
                notice.scope.workspaceId === target.principalRef.workspaceId
            ? []
            : ['Account view scope or principal differs from its provenance'];
    }
    catch {
        return ['Account view invalidation payload or target is malformed'];
    }
}

function validateWorldTarget(
    message: ALMessage,
    target: Extract<WsOutboxProvenance['target'], { kind: 'scoped-world-broadcast'; }>
): readonly string[] {
    const targets = message.targets;
    if (
        message.route.topicId === AppTopics.viewInvalidated || message.payload.typeId === AppTopics.viewInvalidated
    ) {
        try {
            const notice = decodeViewInvalidationMessage(message);
            return notice.principalId === null && notice.scope.applicationId === target.scope.applicationId &&
                    notice.scope.workspaceId === target.scope.workspaceId
                ? []
                : ['Public catalog scope differs from its provenance'];
        }
        catch {
            return ['Public catalog envelope is malformed'];
        }
    }
    return targets?.mode === 'broadcast' && targets.scope === 'world' &&
            message.route.contextId === target.scope.applicationId
        ? []
        : ['WS provenance target differs from scoped world identity'];
}
