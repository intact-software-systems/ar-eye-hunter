import { isALWorldBroadcast } from '../../../al-contracts/is-al-world-broadcast.ts';
import { validateALAccountViewMessage } from '../../../alm/outbound/admission/al-account-view-authority.ts';
import { validateALOutboundRecipientScope } from '../../../alm/outbound/admission/al-outbound-admission-validation.ts';
import { validateALSessionInvalidationMessage } from '../../../alm/outbound/admission/al-session-invalidation-authority.ts';
import { AppTopics } from '../../../api/api-config.ts';
import {
    hasGroupMoveChangedTopic,
    matchesGroupMoveChangedRecipient
} from '../../../api/mutation/group-move-changed.ts';
import { hasServerRoomSnapshotTopic, isServerRoomSnapshotMessage } from '../../../api/views/server-room-snapshot.ts';
import { decodeViewInvalidationMessage } from '../../../api/views/view-invalidation.ts';
import type { WsServerLiveSendInputDto } from '../ws-queue-box-server-contracts.ts';
import { requiresWsQueueBoxServerRecipientScope } from './requires-ws-queue-box-server-recipient-scope.ts';

export function validateLiveSendAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const issues: string[] = [];
    if (
        hasServerRoomSnapshotTopic(input.message) || input.roomSessionGenerations !== undefined ||
        input.roomSnapshotProducer !== undefined
    ) {
        return validateRoomSnapshotAuthority(input);
    }
    if (input.accountView !== undefined) {
        const mixed = input.recipientScope !== undefined || input.inboundScope !== undefined ||
            input.recipientPrincipalId !== undefined || input.sessionInvalidation !== undefined ||
            input.recipientSessionIds !== undefined || input.admittedPeerIds !== undefined;
        return mixed
            ? ['Account view cannot carry another audience authority']
            : validateALAccountViewMessage(input.message, input.accountView);
    }
    if (
        input.message.route.topicId === AppTopics.viewInvalidated ||
        input.message.payload.typeId === AppTopics.viewInvalidated
    ) {
        try {
            const notice = decodeViewInvalidationMessage(input.message);
            if (
                notice.scope === null || (notice.principalId ?? undefined) !== input.recipientPrincipalId ||
                notice.scope.applicationId !== input.recipientScope?.applicationId ||
                notice.scope.workspaceId !== input.recipientScope.workspaceId
            ) {
                return ['Account view requires its exact authority'];
            }
        }
        catch {
            return ['Account view requires a valid envelope and authority'];
        }
    }
    if (
        hasGroupMoveChangedTopic(input.message) && (input.sessionInvalidation !== undefined ||
            !matchesGroupMoveChangedRecipient(input.message, input.recipientScope, input.recipientPrincipalId))
    ) {
        return ['Move Together requires its exact current scoped account audience'];
    }
    if (input.sessionInvalidation !== undefined) {
        issues.push(...validateALSessionInvalidationMessage(input.message, input.sessionInvalidation));
        if (input.recipientScope !== undefined || input.inboundScope !== undefined) {
            issues.push('Session-global authority cannot carry a scoped authority');
        }
    }
    else if (requiresWsQueueBoxServerRecipientScope(input.message)) {
        issues.push(...validateALOutboundRecipientScope(input.inboundScope));
    }
    else if (isALWorldBroadcast(input.message)) {
        issues.push(...validateALOutboundRecipientScope(input.recipientScope ?? input.inboundScope));
    }
    if (input.recipientPrincipalId !== undefined && input.recipientScope === undefined) {
        issues.push('Principal audience requires its scope');
    }
    return issues;
}

function validateRoomSnapshotAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const target = input.message.targets;
    return isServerRoomSnapshotMessage(input.message, input.roomSnapshotProducer) && target?.mode === 'broadcast' &&
            target.groupRef !== undefined && input.recipientScope !== undefined &&
            target.groupRef.applicationId === input.recipientScope.applicationId &&
            target.groupRef.workspaceId === input.recipientScope.workspaceId &&
            input.requireAuthenticatedRecipient === true && input.recipientSessionIds !== undefined &&
            input.roomSessionGenerations !== undefined && input.sessionInvalidation === undefined &&
            input.accountView === undefined && input.recipientPrincipalId === undefined &&
            input.admittedPeerIds === undefined
        ? []
        : ['Server room snapshots require a scoped, generation-fenced room audience'];
}
