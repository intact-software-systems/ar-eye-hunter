import {
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    decodeGroupStateChildStorageKey,
    groupStateScopeStorageKey
} from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    assertGroupRefIdentity,
    decodeStoredGroupStateValue,
    GroupStateRepositoryInvariantCorruptionError
} from '../persistence/group-state-persistence-contracts.ts';

/** Private discovery interest survives rescheduling; only the reservation aggregate holds capacity. */
export interface StoredGroupSessionIntent extends GroupRef {
    readonly principalId: string;
    readonly reviewedScheduleRevision: number;
}

export const GROUP_SESSION_INTENTS_NAMESPACE = 'group-state:session-intents';

export function groupSessionIntentPrincipalPrefix(scope: GroupScope, principalId: string): string {
    requireString(principalId, 'Session intent principal');
    return `${groupStateScopeStorageKey(scope)}:principal=${encodeURIComponent(principalId)}:group=`;
}

export function groupSessionIntentKey(ref: GroupRef, principalId: string): string {
    return groupSessionIntentPrincipalPrefix(ref, principalId) + encodeURIComponent(ref.groupId);
}

/** The private index orders principal before group; reuse the canonical child-key decoder. */
export function decodeGroupSessionIntentKey(key: string): GroupRef & Readonly<{ principalId: string; }> {
    const parts = key.split(':');
    if (parts.length !== 4) {
        throw new TypeError('Session interest key has invalid arity');
    }
    return decodeGroupStateChildStorageKey(
        [parts[0], parts[1], parts[3], parts[2]].join(':'),
        'principal',
        'principalId'
    );
}

export function canonicalStoredGroupSessionIntent(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef
): RuntimeStateEntryValue<StoredGroupSessionIntent> {
    const value = decodeStoredGroupStateValue({
        value: stored.value,
        ref: expected,
        storageKey: stored.entry.key,
        decode: decodeSessionIntent,
        invalidValueMessage: 'Stored session interest is invalid'
    });
    assertGroupRefIdentity(value, expected, stored.entry.key);
    if (stored.entry.key !== groupSessionIntentKey(value, value.principalId)) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            stored.entry.key,
            'Session interest identity differs from its physical key'
        );
    }
    return { entry: stored.entry, value };
}

export function decodeSessionIntent(value: JsonWireValue): StoredGroupSessionIntent {
    const intent = requireRecord(value, 'Session interest');
    requireExactKeys(
        intent,
        ['applicationId', 'workspaceId', 'groupId', 'principalId', 'reviewedScheduleRevision'],
        'Session interest'
    );
    requireString(intent.applicationId, 'Session interest application');
    requireString(intent.workspaceId, 'Session interest workspace');
    requireString(intent.groupId, 'Session interest group');
    requireString(intent.principalId, 'Session interest principal');
    requirePositiveInteger(intent.reviewedScheduleRevision, 'Reviewed schedule revision');
    return {
        applicationId: intent.applicationId,
        workspaceId: intent.workspaceId,
        groupId: intent.groupId,
        principalId: intent.principalId,
        reviewedScheduleRevision: intent.reviewedScheduleRevision as number
    };
}
