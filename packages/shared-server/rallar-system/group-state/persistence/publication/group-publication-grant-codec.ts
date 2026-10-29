import {
    decodeGroupPublicationGrant,
    type GroupPublicationGrant
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    GroupStateRepositoryInvariantCorruptionError,
    throwGroupStateIdentityCorruption
} from '../group-state-persistence-contracts.ts';
import { decodeGroupStatePublicationGrantStorageKey } from './group-publication-grant-storage-key.ts';

/** A stored grant row whose key, group or principal disagree, or that fails the row contract, is corruption. */
export function canonicalStoredPublicationGrant(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef & Readonly<{ principalId?: string; }>
): RuntimeStateEntryValue<GroupPublicationGrant> {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStatePublicationGrantStorageKey);
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeGroupPublicationGrant(stored.value).fold(
        (issues) => {
            throw new GroupStateRepositoryInvariantCorruptionError(
                stored.entry.key,
                `Stored publication grant is invalid: ${formatRallarValidation(issues)}`
            );
        },
        (grant) => grant
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.principalId !== decoded.principalId ||
        (expected.principalId !== undefined && decoded.principalId !== expected.principalId)
    ) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'publication grant principal');
    }
    return { entry: stored.entry, value };
}

/** The group's grant rows, decoded and in principal order. */
export function canonicalStoredPublicationGrants(
    stored: readonly RuntimeStateEntryValue<JsonWireValue>[],
    ref: GroupRef
): readonly RuntimeStateEntryValue<GroupPublicationGrant>[] {
    return stored
        .map((entry) => canonicalStoredPublicationGrant(entry, ref))
        .sort((left, right) => comparePrincipalIds(left.value.principalId, right.value.principalId));
}

function comparePrincipalIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
