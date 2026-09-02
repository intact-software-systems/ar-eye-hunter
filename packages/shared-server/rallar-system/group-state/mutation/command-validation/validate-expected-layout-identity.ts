import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

import {
    isGroupStateRecord,
    validateExactKeys,
    validateNonNegativeSafeInteger,
    validateOneOf,
    validateRecord,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

/** The same named-layout contract is checked at request and command boundaries. */
export function validateExpectedLayoutIdentity(
    input: Readonly<Record<string, unknown>>,
    label: string
): readonly GroupStateValidationIssue[] {
    const record = input.expectedLayout;
    if (!isGroupStateRecord(record)) {
        return validateRecord(record, label);
    }
    return [
        ...validateRequiredKeys(record, GROUP_LAYOUT_IDENTITY_KEYS, label),
        ...validateExactKeys(record, GROUP_LAYOUT_IDENTITY_KEYS, label),
        ...validateNonNegativeSafeInteger(record.groupRevision, `${label} groupRevision`),
        ...validateNonNegativeSafeInteger(record.presenceRevision, `${label} presenceRevision`),
        ...validateNonNegativeSafeInteger(record.version, `${label} version`),
        ...validateOneOf(record.state, GROUP_LAYOUT_IDENTITY_STATES, `${label} state`)
    ];
}

