import { validateRuntimeStateExpiredAuthority } from '../../../../runtime-state/runtime-state-expired-entry.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import {
    authSessionKey,
    authTicketDigestKey,
    authTokenDigestKey
} from '../../persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../../persistence/persisted-auth-session.ts';
import type { AuthMutationCommand, AuthMutationRead, AuthSessionEntries } from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';

export interface AuthMutationValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: AuthMutationRejectedError | TypeError;
}

interface ValidateLiveSessionAuthorityInput {
    readonly expected: Readonly<{
        clientId: string;
        username: string;
        sessionId: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
    readonly read: AuthSessionEntries;
    readonly capturedAtEpochMs: number;
    readonly label: string;
}

interface ValidateIssueSessionReadInput {
    readonly session: PersistedAuthSession | undefined;
    readonly read: Readonly<{ kind: 'issue-session'; }> & AuthSessionEntries;
    readonly path: string;
}

export function equalAuthJson<Left, Right>(left: Left, right: Right): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function assertMatchingAuthKind(
    command: AuthMutationCommand,
    read: AuthMutationRead
): void {
    if (command.kind !== read.kind) {
        throw new TypeError('Auth command/read operation differs');
    }
}

export function requireAuthTicket<T>(
    entry: RuntimeStateEntryValue<T> | null
): RuntimeStateEntryValue<T> {
    if (!entry) {
        throw new AuthMutationRejectedError('Auth ticket is invalid or consumed', 404);
    }
    return entry;
}

export function validateIssueSessionRead(
    input: ValidateIssueSessionReadInput
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    const { session, read, path } = input;
    if (session === undefined) {
        issues.push(toAuthMutationValidationIssue(`${path}.session`, 'Issued auth session is missing'));
        return issues;
    }
    const tokenMatches = !read.byToken || equalAuthJson(read.byToken.value, session);
    const sessionMatches = !read.bySession || equalAuthJson(read.bySession.value, session);
    if (!tokenMatches || !sessionMatches) {
        issues.push(toAuthMutationValidationIssue(path, 'Auth session identity collision', 409));
    }
    if ((read.byToken === null) !== (read.bySession === null)) {
        issues.push(toAuthMutationValidationIssue(path, 'Auth session indexes are inconsistent', 500));
    }
    return issues;
}

export function validateLiveSessionAuthority(
    validation: ValidateLiveSessionAuthorityInput
): readonly AuthMutationValidationIssue[] {
    if (
        !validation.read.bySession ||
        !validation.read.byToken ||
        !equalAuthJson(validation.read.bySession.value, validation.read.byToken.value)
    ) {
        return [toAuthMutationValidationIssue('read.authority', `${validation.label} is unavailable`, 401)];
    }
    const issues: AuthMutationValidationIssue[] = [];
    const session = validation.read.bySession.value;
    if (
        session.clientId !== validation.expected.clientId ||
        session.username !== validation.expected.username ||
        session.sessionId !== validation.expected.sessionId ||
        session.issuedAtEpochMs !== validation.expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== validation.expected.expiresAtEpochMs
    ) {
        issues.push(toAuthMutationValidationIssue('read.authority', `${validation.label} differs`, 403));
    }
    if (session.expiresAtEpochMs <= validation.capturedAtEpochMs) {
        issues.push(toAuthMutationValidationIssue('read.authority', `${validation.label} is expired`, 401));
    }
    return issues;
}

export function assertAuthRuntimeStateAuthority(
    command: AuthMutationCommand,
    read: AuthMutationRead
): void {
    switch (command.kind) {
        case 'issue-session':
            assertSessionEntriesRuntimeAuthority(
                read as Extract<AuthMutationRead, { kind: 'issue-session'; }>,
                command.session
            );
            return;
        case 'issue-ws-ticket': {
            assertWebSocketTicketRuntimeAuthority(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
            );
            return;
        }
        case 'issue-agent-tickets': {
            assertAgentTicketRuntimeAuthority(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>
            );
            return;
        }
        case 'register-user':
        case 'logout-session':
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            return;
    }
}

export function toAuthMutationValidationIssue(
    path: string,
    message: string,
    status = 409
): AuthMutationValidationIssue {
    return { path, message, cause: new AuthMutationRejectedError(message, status) };
}

export function toAuthMutationTypeValidationIssue(
    path: string,
    message: string
): AuthMutationValidationIssue {
    return { path, message, cause: new TypeError(message) };
}

function assertWebSocketTicketRuntimeAuthority(
    command: Extract<AuthMutationCommand, { kind: 'issue-ws-ticket'; }>,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
): void {
    validateRuntimeStateExpiredAuthority({
        live: read.ticket,
        expiredEntry: read.expiredTicketEntry,
        expectedKey: authTicketDigestKey(command.ticketRecord.ticketDigest),
        label: 'Websocket ticket read'
    });
}

function assertAgentTicketRuntimeAuthority(
    command: Extract<AuthMutationCommand, { kind: 'issue-agent-tickets'; }>,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>
): void {
    assertSessionEntriesRuntimeAuthority(read.authority, command.authority);
    for (let index = 0; index < command.tickets.length; index += 1) {
        const ticket = command.tickets[index];
        const sessionRead = read.sessions[index];
        if (sessionRead !== undefined) {
            assertSessionEntriesRuntimeAuthority(sessionRead, {
                ...ticket,
                expiresAtEpochMs: ticket.sessionExpiresAtEpochMs
            });
        }
        validateRuntimeStateExpiredAuthority({
            live: read.tickets[index],
            expiredEntry: read.expiredTicketEntries[index] ?? null,
            expectedKey: authTicketDigestKey(ticket.ticketDigest),
            label: 'Agent ticket read'
        });
    }
}

function assertSessionEntriesRuntimeAuthority(
    read: AuthSessionEntries,
    session: PersistedAuthSession
): void {
    validateRuntimeStateExpiredAuthority({
        live: read.byToken,
        expiredEntry: read.expiredByTokenEntry,
        expectedKey: authTokenDigestKey(session.accessTokenDigest),
        label: 'Auth token index read'
    });
    validateRuntimeStateExpiredAuthority({
        live: read.bySession,
        expiredEntry: read.expiredBySessionEntry,
        expectedKey: authSessionKey(session.sessionId),
        label: 'Auth session index read'
    });
}
