import { isALWorldBroadcast } from '../../../al-contracts/is-al-world-broadcast.ts';
import { validateALOutboundRecipientScope } from '../../../alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    validateALAccountViewMessage,
    type ALAccountViewAuthority
} from '../../../alm/outbound/admission/al-outbound-scope-authority.ts';
import { validateALSessionInvalidationMessage } from '../../../alm/outbound/admission/al-session-invalidation-authority.ts';
import { hasServerRoomSnapshotTopic } from '../../../api/views/server-room-snapshot.ts';
import { hasViewInvalidatedTopic } from '../../../api/views/view-invalidation.ts';
import type { WsServerLiveSendInputDto } from '../ws-queue-box-server-contracts.ts';
import { requiresWsQueueBoxServerRecipientScope } from './requires-ws-queue-box-server-recipient-scope.ts';
import { validateViewInvalidationAudience } from './validate-view-invalidation-authority.ts';

/**
 * A generation-fenced room send and an account view each exclude every other audience authority, so their own
 * validators answer alone; any other send collects the issues of every authority it carries.
 */
export function validateLiveSendAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    if (hasServerRoomSnapshotTopic(input.message) || input.roomSessionGenerations !== undefined) {
        return validateGenerationFencedRoomAuthority(input);
    }
    const accountView = input.accountView;
    if (accountView !== undefined) {
        return validateAccountViewSendAuthority(input, accountView);
    }
    return [
        ...(hasViewInvalidatedTopic(input.message)
            ? validateViewInvalidationAudience(input.message, input.recipientScope, input.recipientPrincipalId)
            : []),
        ...validateRecipientScopeAuthority(input)
    ];
}

/** The captured room audience with each recipient's connection generation; it carries no other authority. */
function validateGenerationFencedRoomAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const issues: string[] = [];
    const target = input.message.targets;
    const groupRef = target?.mode === 'broadcast' && target.scope === 'room' ? target.groupRef : undefined;
    if (
        groupRef === undefined || groupRef.applicationId !== input.recipientScope?.applicationId ||
        groupRef.workspaceId !== input.recipientScope.workspaceId
    ) {
        issues.push('A generation-fenced send requires a room broadcast within its recipient scope');
    }
    if (
        input.requireAuthenticatedRecipient !== true || input.recipientSessionIds === undefined ||
        input.roomSessionGenerations === undefined
    ) {
        issues.push('A generation-fenced send requires authenticated recipients and their captured generations');
    }
    if (
        input.sessionInvalidation !== undefined || input.accountView !== undefined ||
        input.recipientPrincipalId !== undefined || input.admittedPeerIds !== undefined
    ) {
        issues.push('A generation-fenced send cannot carry another audience authority');
    }
    return issues;
}

function validateAccountViewSendAuthority(
    input: WsServerLiveSendInputDto,
    accountView: ALAccountViewAuthority
): readonly string[] {
    const issues = [...validateALAccountViewMessage(input.message, accountView)];
    if (
        input.recipientScope !== undefined || input.inboundScope !== undefined ||
        input.recipientPrincipalId !== undefined || input.sessionInvalidation !== undefined ||
        input.recipientSessionIds !== undefined || input.admittedPeerIds !== undefined
    ) {
        issues.push('Account view cannot carry another audience authority');
    }
    return issues;
}

function validateRecipientScopeAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const issues: string[] = [];
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
