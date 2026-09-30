import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validateALSessionInvalidationMessage } from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { requiresWsQueueBoxServerRecipientScope } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';

import type { WsOutboxProvenance } from './ws-outbox-provenance.ts';

export function validateWsOutboxProvenanceTarget(
    message: ALMessage,
    target: WsOutboxProvenance['target']
): readonly string[] {
    if (target.kind === 'exact-invalidated-session') {
        return validateALSessionInvalidationMessage(message, target.sessionInvalidation);
    }
    const targets = message.targets;
    if (target.kind === 'scoped-world-broadcast') {
        return targets?.mode === 'broadcast' && targets.scope === 'world' &&
                message.route.contextId === target.scope.applicationId
            ? []
            : ['WS provenance target differs from scoped world identity'];
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
    if (target.kind === 'scoped-principal-broadcast') {
        const principalRef = targets?.mode === 'broadcast' && targets.scope === 'principal'
            ? targets.principalRef
            : undefined;
        return principalRef?.applicationId === target.principalRef.applicationId &&
                principalRef.workspaceId === target.principalRef.workspaceId &&
                principalRef.principalId === target.principalRef.principalId
            ? []
            : ['WS provenance target differs from scoped principal identity'];
    }
    return targets?.mode === 'unicast' && requiresWsQueueBoxServerRecipientScope(message) &&
            targets.toPeerId === target.peerId && target.admittedAudience.every((peerId) => peerId === target.peerId)
        ? []
        : ['WS provenance target differs from public unicast identity'];
}
