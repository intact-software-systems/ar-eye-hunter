import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { PersistedAuthSession } from '../repositories/AuthSessionRepository.ts';
import { validateRuntimeStateExpiredAuthority } from '../../runtime-state/RuntimeStateExpiredEntry.ts';
import {
    authSessionKey,
    authTokenDigestKey,
} from '../repositories/auth-storage-keys.ts';
import type {
    AuthMutationCommand,
    AuthMutationRead,
    AuthSessionEntries,
} from '../auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth/mutation/auth-mutation-rejected-error.ts';

export function equalAuthJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function requireMatchingAuthKind(
    command: AuthMutationCommand,
    read: AuthMutationRead,
): void {
    if (command.kind !== read.kind) {
        throw new AuthMutationRejectedError('Auth command/read operation differs');
    }
}

export function requireAuthTicket<T>(
    entry: RuntimeStateEntryValue<T> | null,
): RuntimeStateEntryValue<T> {
    if (!entry) {
        throw new AuthMutationRejectedError('Auth ticket is invalid or consumed', 404);
    }
    return entry;
}

export function validateIssueSessionRead(
    session: PersistedAuthSession | undefined,
    read: Readonly<{ kind: 'issue-session' }> & AuthSessionEntries,
): void {
    if (!session) throw new AuthMutationRejectedError('Issued auth session is missing');
    validateRuntimeStateExpiredAuthority(
        read.byToken,
        read.expiredByTokenEntry,
        authTokenDigestKey(session.accessTokenDigest),
        'Auth token index read',
    );
    validateRuntimeStateExpiredAuthority(
        read.bySession,
        read.expiredBySessionEntry,
        authSessionKey(session.sessionId),
        'Auth session index read',
    );
    const tokenMatches = !read.byToken || equalAuthJson(read.byToken.value, session);
    const sessionMatches = !read.bySession || equalAuthJson(read.bySession.value, session);
    if (!tokenMatches || !sessionMatches) {
        throw new AuthMutationRejectedError('Auth session identity collision', 409);
    }
    if ((read.byToken === null) !== (read.bySession === null)) {
        throw new AuthMutationRejectedError('Auth session indexes are inconsistent', 500);
    }
}

export function validateLiveSessionAuthority(
    expected: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>,
    read: AuthSessionEntries,
    capturedAtEpochMs: number,
    label: string,
): void {
    if (
        !read.bySession || !read.byToken ||
        !equalAuthJson(read.bySession.value, read.byToken.value)
    ) {
        throw new AuthMutationRejectedError(`${label} is unavailable`, 401);
    }
    const session = read.bySession.value;
    if (
        session.clientId !== expected.clientId ||
        session.username !== expected.username ||
        session.sessionId !== expected.sessionId ||
        session.issuedAtEpochMs !== expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== expected.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError(`${label} differs`, 403);
    }
    if (session.expiresAtEpochMs <= capturedAtEpochMs) {
        throw new AuthMutationRejectedError(`${label} is expired`, 401);
    }
}
