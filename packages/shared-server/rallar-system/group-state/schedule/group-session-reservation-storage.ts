import { requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeGroupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    assertGroupRefIdentity,
    decodeStoredGroupStateKey,
    decodeStoredGroupStateValue
} from '../persistence/group-state-persistence-contracts.ts';
import { decodeGroupSessionReservations, type GroupSessionReservations } from './group-session-reservations.ts';

export interface StoredGroupSessionReservations extends GroupRef, GroupSessionReservations {}

export const GROUP_SESSION_RESERVATIONS_NAMESPACE = 'group-state:session-reservations';

/** The physical slot, stored scope and requested room must all agree before reservations affect admission. */
export function canonicalStoredGroupSessionReservations(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef
): RuntimeStateEntryValue<StoredGroupSessionReservations> {
    const ref = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateGroupStorageKey);
    assertGroupRefIdentity(ref, expected, stored.entry.key);
    const value = decodeStoredGroupStateValue({
        value: stored.value,
        ref,
        storageKey: stored.entry.key,
        decode: decodeStoredGroupSessionReservations,
        invalidValueMessage: 'Stored session reservations are invalid'
    });
    assertGroupRefIdentity(value, ref, stored.entry.key);
    return { entry: stored.entry, value };
}

function decodeStoredGroupSessionReservations(value: JsonWireValue): StoredGroupSessionReservations {
    const stored = requireRecord(value, 'Stored session reservations');
    requireExactKeys(
        stored,
        ['applicationId', 'workspaceId', 'groupId', 'scheduleRevision', 'principalIds'],
        'Stored session reservations'
    );
    requireString(stored.applicationId, 'Reservation application');
    requireString(stored.workspaceId, 'Reservation workspace');
    requireString(stored.groupId, 'Reservation group');
    return {
        applicationId: stored.applicationId,
        workspaceId: stored.workspaceId,
        groupId: stored.groupId,
        ...decodeGroupSessionReservations({
            scheduleRevision: stored.scheduleRevision,
            principalIds: stored.principalIds
        })
    };
}
