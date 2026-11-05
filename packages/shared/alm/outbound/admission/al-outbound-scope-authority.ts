import { readALTargetGroupRef, type ALMessage } from '../../../al-contracts/al-contract.ts';
import type { GroupRef } from '../../../api/group-types.ts';
import type { StateScope } from '../../../api/state-types.ts';
import { decodeViewInvalidationMessage, type ViewInvalidation } from '../../../api/views/view-invalidation.ts';
import { Either } from '../../../resilience/Either.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../../al-admission-value-validation.ts';
import { validateALOutboundRecipientScope } from './al-outbound-admission-validation.ts';
import type { ALSessionInvalidationAuthority } from './al-session-invalidation-authority.ts';

/** Committed account-view authority; it never carries a scope or a captured socket audience. */
export interface ALAccountViewAuthority {
    readonly version: 1;
    readonly principalId: string;
}

/** The recipient fields a captured policy, a dequeue authority or a repair request carries beside a WS row. */
export interface ALOutboundRecipientAuthorityFields {
    readonly recipientScope?: StateScope;
    readonly principalTargetId?: string;
    readonly sessionInvalidation?: ALSessionInvalidationAuthority;
    readonly accountView?: ALAccountViewAuthority;
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
    | Readonly<{ kind: 'account-view'; accountView: ALAccountViewAuthority; }>
    | Readonly<{ kind: 'none'; }>;

export function resolveALOutboundScopeAuthority(
    message: ALMessage,
    fields: ALOutboundRecipientAuthorityFields
): Either<readonly string[], ALOutboundScopeAuthority> {
    const { recipientScope, principalTargetId, sessionInvalidation, accountView } = fields;
    if (accountView !== undefined) {
        return recipientScope === undefined && principalTargetId === undefined && sessionInvalidation === undefined &&
                readALTargetGroupRef(message) === undefined
            ? Either.ofRight({ kind: 'account-view', accountView })
            : Either.ofLeft(['Account-view authority cannot carry another recipient authority']);
    }
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

export function decodeALAccountViewAuthority(value: unknown): ALAccountViewAuthority {
    const authority = decodeALAdmissionRecord(value, ['version', 'principalId']);
    if (authority.version !== 1) {
        throw new TypeError('Unsupported account-view authority version');
    }
    return { version: 1, principalId: decodeALAdmissionString(authority.principalId) };
}

/** The row must be the account-wide view notice of exactly the authority's principal. */
export function validateALAccountViewMessage(message: ALMessage, authority: ALAccountViewAuthority): readonly string[] {
    let notice: ViewInvalidation;
    try {
        notice = decodeViewInvalidationMessage(message);
    }
    catch {
        return ['Account view message is malformed'];
    }
    return message.payload.contentType === 'application/json' && notice.scope === null &&
            notice.principalId === authority.principalId
        ? []
        : ['Account view differs from its exact account authority'];
}
