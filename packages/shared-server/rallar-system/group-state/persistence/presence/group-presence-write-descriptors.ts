import type {
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type {
    RuntimeStateGuardedBatchDelete,
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { toSessionPurgeAfterEpochMs } from '../../../presence/session-expiry.ts';
import { groupStateGroupStorageKey } from '../aggregate/group-aggregate-storage-keys.ts';
import {
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary
} from '../validate-persisted-group-presence.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './group-presence-storage-keys.ts';

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
