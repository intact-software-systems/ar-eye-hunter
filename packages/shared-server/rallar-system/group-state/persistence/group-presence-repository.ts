import type {
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryRead,
    type RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { toSessionPurgeAfterEpochMs } from '../../repositories/session-expiry.ts';
import {
    normalizePersistedGroupPresenceAdmission,
    normalizePersistedGroupPresenceSession,
    normalizePersistedGroupPresenceSummary,
} from './group-state-persistence-codec.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    normalizeStoredGroupStateValue,
    throwGroupStateIdentityCorruption,
    toLiveGroupStateEntryValue,
} from './group-state-persistence-contracts.ts';
import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStatePresenceAdmissionStorageKey,
    decodeGroupStatePresenceSessionStorageKey,
    groupStateGroupStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
} from './group-state-storage-keys.ts';
import {
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE,
} from './group-state-runtime-namespaces.ts';
import {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary,
} from './validate-persisted-group-presence.ts';

export class GroupPresenceRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putPresenceSession(session: GroupPresenceSession): Promise<void> {
        validatePersistedGroupPresenceSession(session, session);
        await this.putValue(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
        );
    }

    async readPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<RuntimeStateEntryRead<GroupPresenceSession>> {
        const stored = await this.getEntryRead<unknown>(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(ref),
        );
        return {
            value: stored.value ? canonicalStoredSession(stored.value, ref) : undefined,
            expiredEntry: stored.expiredEntry,
        };
    }

    async insertPresence(
        session: GroupPresenceSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceSession(session, session);
        return await this.putValueIfAbsent(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
        );
    }

    async updatePresence(
        session: GroupPresenceSession,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceSession(session, session);
        return await this.putValueIfRevision(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
            expectedRevision,
        );
    }

    async deletePresence(
        ref: GroupRef & Readonly<{ sessionId: string }>,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(ref),
            expectedRevision,
        );
    }

    async listPresenceSessionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceSession>[]> {
        const stored = await this.listEntryValues<unknown>(
            SESSIONS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`,
        );
        return stored.map((entry) => canonicalStoredSession(entry, ref));
    }

    async findPresenceAdmissionEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupPresenceAdmission> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(ref),
        );
        return stored ? canonicalStoredAdmission(stored, ref) : undefined;
    }

    async insertPresenceAdmission(
        admission: GroupPresenceAdmission,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceAdmission(admission, admission);
        return await this.putValueIfAbsent(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(admission),
            admission,
        );
    }

    async updatePresenceAdmission(
        admission: GroupPresenceAdmission,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceAdmission(admission, admission);
        return await this.putValueIfRevision(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(admission),
            admission,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
    }

    async listPresenceAdmissionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceAdmission>[]> {
        const stored = await this.listEntryValues<unknown>(
            PRESENCE_ADMISSIONS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`,
        );
        return stored.map((entry) => canonicalStoredAdmission(entry, ref));
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        const stored = await this.listEntryValues<unknown>(SESSIONS_NAMESPACE);
        return stored.map((entry) => canonicalStoredSession(entry).value);
    }

    async removePresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<void> {
        await this.deleteValue(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(ref),
        );
    }

    async findPresenceSummaryEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(ref),
        );
        return stored ? canonicalStoredSummary(stored, ref) : undefined;
    }

    async insertPresenceSummary(
        summary: GroupPresenceSummary,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceSummary(summary, summary);
        return await this.putValueIfAbsent(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(summary),
            summary,
        );
    }

    async updatePresenceSummary(
        summary: GroupPresenceSummary,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedGroupPresenceSummary(summary, summary);
        return await this.putValueIfRevision(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(summary),
            summary,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
    }

    protected override async toLiveEntryValue<T>(
        _namespace: string,
        entry: RuntimeStateEntry,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        return await toLiveGroupStateEntryValue<T>(entry);
    }
}

export function canonicalStoredSession(
    stored: RuntimeStateEntryValue<unknown>,
    expected?: GroupRef & Readonly<{ sessionId?: string }>,
): RuntimeStateEntryValue<GroupPresenceSession> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStatePresenceSessionStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = normalizeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        normalizePersistedGroupPresenceSession,
        'Stored group presence session value is invalid',
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
    stored: RuntimeStateEntryValue<unknown>,
    expected?: GroupRef & Readonly<{ principalId?: string }>,
): RuntimeStateEntryValue<GroupPresenceAdmission> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStatePresenceAdmissionStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = normalizeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        normalizePersistedGroupPresenceAdmission,
        'Stored group presence admission value is invalid',
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined &&
            decoded.principalId !== expected.principalId)
    ) {
        throwGroupStateIdentityCorruption(
            stored.entry.key,
            'presence admission principal',
        );
    }
    return { entry: stored.entry, value };
}

export function canonicalStoredSummary(
    stored: RuntimeStateEntryValue<unknown>,
    expected: GroupRef,
): RuntimeStateEntryValue<GroupPresenceSummary> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStateGroupStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = normalizeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        normalizePersistedGroupPresenceSummary,
        'Stored group presence summary value is invalid',
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    return { entry: stored.entry, value };
}
