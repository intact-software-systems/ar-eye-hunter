import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requireRecord
} from '../../group-state-validation-primitives.ts';

/**
 * The wire shape of a named layout identity, shared by the request boundary
 * and the command validator so a fenced command cannot be shape-checked in
 * one place and not the other.
 */
/**
 * The decoded request or command input the named identity rides in — a
 * boundary record whose values are still untrusted at this point.
 */
export type ExpectedLayoutIdentityCarrier = ReturnType<typeof requireRecord>;

export function validateExpectedLayoutIdentity(
    input: ExpectedLayoutIdentityCarrier,
    label: string
): void {
    const record = requireRecord(input.expectedLayout, label);
    assertRequiredKeys(record, GROUP_LAYOUT_IDENTITY_KEYS, label);
    assertExactKeys(record, GROUP_LAYOUT_IDENTITY_KEYS, label);
    for (const key of ['groupRevision', 'presenceRevision', 'version'] as const) {
        requireNonNegativeSafeInteger(record[key], `${label} ${key}`);
    }
    requireOneOf(record.state, GROUP_LAYOUT_IDENTITY_STATES, `${label} state`);
}
