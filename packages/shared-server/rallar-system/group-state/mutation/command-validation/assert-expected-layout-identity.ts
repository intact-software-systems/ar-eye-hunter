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

/** Assert the persisted/internal command's layout identity before executing its fence. */
export function assertExpectedLayoutIdentity(
    input: Readonly<Record<string, unknown>>,
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
