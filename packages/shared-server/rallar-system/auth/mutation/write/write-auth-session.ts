import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateConditionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';

import { writeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import {
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    AUTH_SESSIONS_BY_TOKEN_NAMESPACE
} from '../../persistence/auth-storage-keys.ts';
import type {
    AuthComputedSession,
    AuthMutationComputed
} from '../auth-mutation-contracts.ts';

type AuthLogoutComputed = Extract<AuthMutationComputed, { kind: 'logout-session'; }>;

export async function writeAuthSession(
    repository: RuntimeStateConditionalRepositoryLike,
    computed: AuthComputedSession
): Promise<void> {
    const token = computed.expectedTokenRevision === null
        ? await repository.insertIfAbsent(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            computed.tokenStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp
        )
        : await repository.upsertIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            computed.tokenStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp,
            computed.expectedTokenRevision
        );
    requireConditionalWrite(token);
    const session = computed.expectedSessionRevision === null
        ? await repository.insertIfAbsent(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            computed.sessionStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp
        )
        : await repository.upsertIfRevision(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            computed.sessionStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp,
            computed.expectedSessionRevision
        );
    requireConditionalWrite(session);
}

export async function writeAuthLogout(
    transaction: PSqlSql,
    repository: RuntimeStateConditionalRepositoryLike,
    computed: AuthLogoutComputed
): Promise<void> {
    const deletion = computed.logoutDeletion;
    if (!deletion) {
        return;
    }
    requireConditionalWrite(
        await repository.deleteIfRevision(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            deletion.sessionStorageKey,
            deletion.expectedSessionRevision
        )
    );
    requireConditionalWrite(
        await repository.deleteIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            deletion.tokenStorageKey,
            deletion.expectedTokenRevision
        )
    );
    if (computed.logoutOutbox) {
        await writeAppOutboxInsert(transaction, computed.logoutOutbox);
    }
}
