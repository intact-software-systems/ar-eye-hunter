import { readALTargetGroupRef, type ALMessage } from '../../../al-contracts/al-contract.ts';
import type { GroupRef } from '../../../api/group-types.ts';
import type { StateScope } from '../../../api/state-types.ts';
import { Either } from '../../../resilience/Either.ts';
import { validateALOutboundRecipientScope } from './al-outbound-admission-validation.ts';
import type { ALSessionInvalidationAuthority } from './al-session-invalidation-authority.ts';

/** The recipient fields a captured policy, a dequeue authority or a repair request carries beside a WS row. */
export interface ALOutboundRecipientAuthorityFields {
    readonly recipientScope?: StateScope;
    readonly principalTargetId?: string;
    readonly sessionInvalidation?: ALSessionInvalidationAuthority;
}

/** The one fact that scopes a WS row's recipients. A row whose targets name a group stores no scope of its own. */
export type ALOutboundScopeAuthority =
    | Readonly<{ kind: 'group-ref'; groupRef: GroupRef; }>
    | Readonly<{
        kind: 'recipient-scope';
        recipientScope: StateScope;
        principalTargetId: string | undefined;
    }>
    | Readonly<{ kind: 'session-invalidation'; sessionInvalidation: ALSessionInvalidationAuthority; }>
    | Readonly<{ kind: 'none'; }>;

export function resolveALOutboundScopeAuthority(
    message: ALMessage,
    fields: ALOutboundRecipientAuthorityFields
): Either<readonly string[], ALOutboundScopeAuthority> {
    const { recipientScope, principalTargetId, sessionInvalidation } = fields;
    const groupRef = readALTargetGroupRef(message);
    if (groupRef !== undefined) {
        return recipientScope === undefined && principalTargetId === undefined &&
                sessionInvalidation === undefined
            ? Either.ofRight({ kind: 'group-ref', groupRef })
            : Either.ofLeft([
                'A row whose targets name a group stores no second recipient authority'
            ]);
    }
    if (sessionInvalidation !== undefined) {
        return recipientScope === undefined && principalTargetId === undefined
            ? Either.ofRight({ kind: 'session-invalidation', sessionInvalidation })
            : Either.ofLeft(['Session-global authority cannot carry a scoped authority']);
    }
    if (recipientScope === undefined) {
        return principalTargetId === undefined
            ? Either.ofRight({ kind: 'none' })
            : Either.ofLeft(['A principal target requires its recipient scope']);
    }
    const issues = validateALOutboundRecipientScope(recipientScope);
    return issues.length === 0
        ? Either.ofRight({ kind: 'recipient-scope', recipientScope, principalTargetId })
        : Either.ofLeft(issues);
}
