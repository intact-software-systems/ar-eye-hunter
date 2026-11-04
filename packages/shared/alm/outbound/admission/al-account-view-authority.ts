import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeViewInvalidationMessage } from '../../../api/views/view-invalidation.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../../al-admission-value-validation.ts';

/** Committed account-view authority; it never carries a scope or a captured socket audience. */
export interface ALAccountViewAuthority {
    readonly version: 1;
    readonly principalId: string;
}

export function decodeALAccountViewAuthority(value: unknown): ALAccountViewAuthority {
    const authority = decodeALAdmissionRecord(value, ['version', 'principalId']);
    if (authority.version !== 1) {
        throw new TypeError('Unsupported account-view authority version');
    }
    return { version: 1, principalId: decodeALAdmissionString(authority.principalId) };
}

export function validateALAccountViewMessage(message: ALMessage, authority: ALAccountViewAuthority): readonly string[] {
    try {
        const notice = decodeViewInvalidationMessage(message);
        const decoded = decodeALAccountViewAuthority(authority);
        return message.payload.contentType === 'application/json' && notice.scope === null &&
                notice.principalId === decoded.principalId
            ? []
            : ['Account view differs from its exact account authority'];
    }
    catch {
        return ['Account view message or authority is malformed'];
    }
}
