import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type {
    RuntimeStateGuardedBatchDelete,
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchPut,
    RuntimeStateGuardedBatchUpdate
} from '../../../runtime-state/RuntimeStateGuardedBatch.ts';
import { toSessionPurgeAfterEpochMs } from '../../presence/session-expiry.ts';
import { type GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { validateGroupMutationIdempotencyRecord } from '../mutation/result-validation/validate-group-mutation-result.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './group-state-storage-keys.ts';
import {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary
} from './validate-persisted-group-presence.ts';
import { validatePersistedGroup, validatePersistedGroupMember } from './validate-persisted-group.ts';

export const GROUPS_NAMESPACE = 'group-state:groups';
export const MEMBERS_NAMESPACE = 'group-state:members';
export const SESSIONS_NAMESPACE = 'group-state:sessions';
export const PRESENCE_SUMMARIES_NAMESPACE = 'group-state:presence-summaries';
export const PRESENCE_ADMISSIONS_NAMESPACE = 'group-state:presence-admissions';
export const IDEMPOTENT_NAMESPACE = 'group-state:idempotent';

export interface GroupStateIdempotencyDescriptorInput {
    readonly ref: GroupRef;
    readonly requestId: string;
    readonly record: GroupMutationIdempotencyRecord;
    readonly expireAtTimestamp: number;
}

export function groupStateInsertGroupDescriptor(group: Group): RuntimeStateGuardedBatchInsert {
    validatePersistedGroup(group, group);
    return {
        operation: 'insert',
        namespace: GROUPS_NAMESPACE,
        key: groupStateGroupStorageKey(group),
        value: serializeGroupStateValue(group),
        expireAtTimestamp: group.purgeAfterEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateUpdateGroupDescriptor(
    group: Group,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    validatePersistedGroup(group, group);
    return {
        operation: 'update',
        namespace: GROUPS_NAMESPACE,
        key: groupStateGroupStorageKey(group),
        expectedRevision,
        value: serializeGroupStateValue(group),
        expireAtTimestamp: group.purgeAfterEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateMemberPutDescriptor(member: GroupMember): RuntimeStateGuardedBatchPut {
    validatePersistedGroupMember(member, member);
    return {
        operation: 'put',
        namespace: MEMBERS_NAMESPACE,
        key: groupStateMemberStorageKey(member),
        value: serializeGroupStateValue(member),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateInsertPresenceDescriptor(
    session: GroupPresenceSession
): RuntimeStateGuardedBatchInsert {
    validatePersistedGroupPresenceSession(session, session);
    return {
        operation: 'insert',
        namespace: SESSIONS_NAMESPACE,
        key: groupStatePresenceSessionStorageKey(session),
        value: serializeGroupStateValue(session),
        expireAtTimestamp: toSessionPurgeAfterEpochMs(
            session.expiresAtEpochMs,
            session.disconnectedAtEpochMs
        )
    };
}

export function groupStateUpdatePresenceDescriptor(
    session: GroupPresenceSession,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    const inserted = groupStateInsertPresenceDescriptor(session);
    return { ...inserted, operation: 'update', expectedRevision };
}

export function groupStateDeletePresenceDescriptor(
    session: GroupRef & Readonly<{ sessionId: string; }>,
    expectedRevision: number
): RuntimeStateGuardedBatchDelete {
    return {
        operation: 'delete',
        namespace: SESSIONS_NAMESPACE,
        key: groupStatePresenceSessionStorageKey(session),
        expectedRevision
    };
}

export function groupStateInsertPresenceAdmissionDescriptor(
    admission: GroupPresenceAdmission
): RuntimeStateGuardedBatchInsert {
    validatePersistedGroupPresenceAdmission(admission, admission);
    return {
        operation: 'insert',
        namespace: PRESENCE_ADMISSIONS_NAMESPACE,
        key: groupStatePresenceAdmissionStorageKey(admission),
        value: serializeGroupStateValue(admission),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateUpdatePresenceAdmissionDescriptor(
    admission: GroupPresenceAdmission,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    const inserted = groupStateInsertPresenceAdmissionDescriptor(admission);
    return { ...inserted, operation: 'update', expectedRevision };
}

export function groupStateInsertPresenceSummaryDescriptor(
    summary: GroupPresenceSummary
): RuntimeStateGuardedBatchInsert {
    validatePersistedGroupPresenceSummary(summary, summary);
    return {
        operation: 'insert',
        namespace: PRESENCE_SUMMARIES_NAMESPACE,
        key: groupStateGroupStorageKey(summary),
        value: serializeGroupStateValue(summary),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export function groupStateUpdatePresenceSummaryDescriptor(
    summary: GroupPresenceSummary,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    const inserted = groupStateInsertPresenceSummaryDescriptor(summary);
    return { ...inserted, operation: 'update', expectedRevision };
}

export function groupStateInsertIdempotencyDescriptor(
    input: GroupStateIdempotencyDescriptorInput
): RuntimeStateGuardedBatchInsert {
    validateGroupMutationIdempotencyRecord(input.record, input.ref);
    if (input.record.requestId !== input.requestId) {
        throw new TypeError('Group idempotency request identity differs');
    }
    return {
        operation: 'insert',
        namespace: IDEMPOTENT_NAMESPACE,
        key: groupStateIdempotencyStorageKey(input.ref, input.requestId),
        value: serializeGroupStateValue(input.record),
        expireAtTimestamp: input.expireAtTimestamp
    };
}

function serializeGroupStateValue(value: object): string {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
        throw new TypeError('Group state value is not JSON serializable');
    }
    return serialized;
}
