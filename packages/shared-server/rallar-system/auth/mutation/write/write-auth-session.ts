import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { AuthSessionRepository } from '../../persistence/auth-session-repository.ts';
import { requireIssueSessionLifecycle } from '../../sessions/require-issue-session-lifecycle.ts';
import type {
    AuthComputedSession,
    AuthMutationComputed,
    AuthMutationRead,
    AuthSessionEntries
} from '../auth-mutation-contracts.ts';

export async function writeAuthSession(
    repository: AuthSessionRepository,
    computed: AuthComputedSession,
    read: AuthSessionEntries
): Promise<void> {
    requireConditionalWrite(
        await repository.insertSessionByTokenDigest(
            computed.session,
            read.expiredByTokenEntry?.revision ?? null
        )
    );
    requireConditionalWrite(
        await repository.insertSessionBySessionId(
            computed.session,
            read.expiredBySessionEntry?.revision ?? null
        )
    );
}

export async function writeAuthSessionIssue(
    repository: AuthSessionRepository,
    computed: AuthMutationComputed
): Promise<void> {
    requireIssueSessionLifecycle(computed.command.capturedAtEpochMs, computed.sessions[0].session);
    await writeAuthSession(
        repository,
        computed.sessions[0],
        computed.read as Extract<AuthMutationRead, { kind: 'issue-session'; }>
    );
}

export async function writeAuthLogout(
    transaction: PSqlSql,
    repository: AuthSessionRepository,
    computed: AuthMutationComputed
): Promise<void> {
    const command = computed.command as Extract<AuthMutationComputed['command'], { kind: 'logout-session'; }>;
    const read = computed.read as Extract<AuthMutationRead, { kind: 'logout-session'; }>;
    if (!read.bySession || !read.byToken) {
        return;
    }
    requireConditionalWrite(
        await repository.deleteSessionBySessionIdIfRevision(
            command.expected.sessionId,
            read.bySession.entry.revision
        )
    );
    requireConditionalWrite(
        await repository.deleteSessionTokenStorageKeyIfRevision(
            read.byToken.entry.key,
            read.byToken.entry.revision
        )
    );
    if (computed.logoutOutbox) {
        await createPSqlResourceInboxRepository(transaction).entries.writeIfAbsentOrMatch(computed.logoutOutbox);
    }
}
