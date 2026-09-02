import type {
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue
} from '../../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../../runtime-state/runtime-state-repository.ts';
import { toSessionPurgeAfterEpochMs } from '../../../presence/session-expiry.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey
} from '../aggregate/group-aggregate-storage-keys.ts';
import {
    decodePersistedGroupPresenceAdmission,
    decodePersistedGroupPresenceSession,
    decodePersistedGroupPresenceSummary
} from '../group-state-persistence-codec.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    decodeStoredGroupStateValue,
    throwGroupStateIdentityCorruption
} from '../group-state-persistence-contracts.ts';
import {
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from '../group-state-runtime-namespaces.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue
} from '../validate-persisted-group-presence.ts';
import {
    decodeGroupStatePresenceAdmissionStorageKey,
    decodeGroupStatePresenceSessionStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './group-presence-storage-keys.ts';

export class GroupPresenceRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putPresenceSession(session: GroupPresenceSession): Promise<void> {
        const persistedGroupPresenceSessionIssues = validatePresenceSession(
            session,
            session,
            'Stored group presence session'
        );
        if (persistedGroupPresenceSessionIssues.length > 0) {
            throw persistedGroupPresenceSessionIssues[0].cause;
        }
        await this.putValue(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs)
        );
    }

    async insertPresence(session: GroupPresenceSession): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceSessionIssues = validatePresenceSession(
            session,
            session,
            'Stored group presence session'
        );
        if (persistedGroupPresenceSessionIssues.length > 0) {
            throw persistedGroupPresenceSessionIssues[0].cause;
        }
        return await this.putValueIfAbsent(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs)
        );
    }

    async updatePresence(
        session: GroupPresenceSession,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceSessionIssues = validatePresenceSession(
            session,
            session,
            'Stored group presence session'
        );
        if (persistedGroupPresenceSessionIssues.length > 0) {
            throw persistedGroupPresenceSessionIssues[0].cause;
        }
        return await this.putValueIfRevision(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs),
            expectedRevision
        );
    }

    async deletePresence(
        ref: GroupRef & Readonly<{ sessionId: string; }>,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(ref),
            expectedRevision
        );
    }

    async insertPresenceAdmission(
        admission: GroupPresenceAdmission
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceAdmissionIssues = validatePresenceAdmission(admission, admission);
        if (persistedGroupPresenceAdmissionIssues.length > 0) {
            throw persistedGroupPresenceAdmissionIssues[0].cause;
        }
        return await this.putValueIfAbsent(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(admission),
            admission
        );
    }

    async updatePresenceAdmission(
        admission: GroupPresenceAdmission,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceAdmissionIssues = validatePresenceAdmission(admission, admission);
        if (persistedGroupPresenceAdmissionIssues.length > 0) {
            throw persistedGroupPresenceAdmissionIssues[0].cause;
        }
        return await this.putValueIfRevision(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(admission),
            admission,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision
        );
    }

    async removePresenceSession(ref: GroupRef & Readonly<{ sessionId: string; }>): Promise<void> {
        await this.deleteValue(SESSIONS_NAMESPACE, groupStatePresenceSessionStorageKey(ref));
    }

    async insertPresenceSummary(
        summary: GroupPresenceSummary
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceSummaryIssues = validatePresenceSummaryValue(summary, summary);
        if (persistedGroupPresenceSummaryIssues.length > 0) {
            throw persistedGroupPresenceSummaryIssues[0].cause;
        }
        return await this.putValueIfAbsent(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(summary),
            summary
        );
    }

    async updatePresenceSummary(
        summary: GroupPresenceSummary,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persistedGroupPresenceSummaryIssues = validatePresenceSummaryValue(summary, summary);
        if (persistedGroupPresenceSummaryIssues.length > 0) {
            throw persistedGroupPresenceSummaryIssues[0].cause;
        }
        return await this.putValueIfRevision(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(summary),
            summary,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision
        );
    }
}

export function canonicalStoredSession(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected?: GroupRef & Readonly<{ sessionId?: string; }>
): RuntimeStateEntryValue<GroupPresenceSession> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStatePresenceSessionStorageKey
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        decodePersistedGroupPresenceSession,
        'Stored group presence session value is invalid'
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.sessionId !== decoded.sessionId ||
        (expected?.sessionId !== undefined && decoded.sessionId !== expected.sessionId)
    ) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'presence session');
    }
    return { entry: stored.entry, value };
}

export function canonicalStoredAdmission(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected?: GroupRef & Readonly<{ principalId?: string; }>
): RuntimeStateEntryValue<GroupPresenceAdmission> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStatePresenceAdmissionStorageKey
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        decodePersistedGroupPresenceAdmission,
        'Stored group presence admission value is invalid'
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined && decoded.principalId !== expected.principalId)
    ) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'presence admission principal');
    }
    return { entry: stored.entry, value };
}

export function canonicalStoredSummary(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef
): RuntimeStateEntryValue<GroupPresenceSummary> {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateGroupStorageKey);
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        decodePersistedGroupPresenceSummary,
        'Stored group presence summary value is invalid'
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    return { entry: stored.entry, value };
}
