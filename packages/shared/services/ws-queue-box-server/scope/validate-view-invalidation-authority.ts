import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { type ALOutboundScopeAuthority } from '../../../alm/outbound/admission/al-outbound-scope-authority.ts';
import { decodeViewInvalidationMessage } from '../../../api/views/view-invalidation.ts';

export function validateViewInvalidationAuthority(
    message: ALMessage,
    scope: Extract<ALOutboundScopeAuthority, { kind: 'recipient-scope'; }>,
    admittedAudience: readonly string[] | undefined
): readonly string[] {
    try {
        const notice = decodeViewInvalidationMessage(message);
        if (notice.principalId === null) {
            return admittedAudience === undefined && scope.principalTargetId === undefined &&
                    scope.recipientScope.applicationId === notice.scope.applicationId &&
                    scope.recipientScope.workspaceId === notice.scope.workspaceId
                ? []
                : ['Public catalog requires its exact scope and live subscriber audience'];
        }
        return notice.scope !== null && admittedAudience !== undefined &&
                scope.principalTargetId === notice.principalId &&
                scope.recipientScope.applicationId === notice.scope.applicationId &&
                scope.recipientScope.workspaceId === notice.scope.workspaceId
            ? []
            : ['Account view requires its exact scoped principal authority'];
    }
    catch {
        return ['Account view envelope is malformed'];
    }
}
