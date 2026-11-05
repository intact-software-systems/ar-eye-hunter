import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { type ALOutboundScopeAuthority } from '../../../alm/outbound/admission/al-outbound-scope-authority.ts';
import type { StateScope } from '../../../api/state-types.ts';
import { decodeViewInvalidationMessage, type ViewInvalidation } from '../../../api/views/view-invalidation.ts';

/** A scoped view notice reaches exactly the scope and principal it names; a public catalog names no principal. */
export function validateViewInvalidationAudience(
    message: ALMessage,
    recipientScope: StateScope | undefined,
    principalId: string | undefined
): readonly string[] {
    let notice: ViewInvalidation;
    try {
        notice = decodeViewInvalidationMessage(message);
    }
    catch {
        return ['View invalidation envelope is malformed'];
    }
    return notice.scope !== null && (notice.principalId ?? undefined) === principalId &&
            notice.scope.applicationId === recipientScope?.applicationId &&
            notice.scope.workspaceId === recipientScope.workspaceId
        ? []
        : ['View invalidation differs from its exact scope and principal'];
}

/** A captured row also fixes who it reaches: an account view its frozen sessions, a public catalog its live subscribers. */
export function validateViewInvalidationAuthority(
    message: ALMessage,
    scope: Extract<ALOutboundScopeAuthority, { kind: 'recipient-scope'; }>,
    admittedAudience: readonly string[] | undefined
): readonly string[] {
    const issues = [...validateViewInvalidationAudience(message, scope.recipientScope, scope.principalTargetId)];
    if ((scope.principalTargetId === undefined) !== (admittedAudience === undefined)) {
        issues.push('A public catalog reaches live subscribers and an account view only its frozen sessions');
    }
    return issues;
}
