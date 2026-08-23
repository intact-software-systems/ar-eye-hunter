import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { decodePersistedAuthSession, type PersistedAuthSession } from '../../persistence/auth-persistence-contracts.ts';
import { requireIssueSessionLifecycle } from '../../sessions/require-issue-session-lifecycle.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    AuthMutationResult,
    IssueAuthSessionCommand,
    LogoutAuthSessionCommand
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { equalAuthJson } from '../validate/auth-mutation-validation.ts';
import { toAuthLogoutOutbox } from './to-auth-logout-outbox.ts';

type AuthSessionMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-session' | 'logout-session'; }>;
type AuthConsumedSessionReceipt = Extract<
    AuthMutationResult,
    { kind: 'ws-ticket-consumed' | 'agent-ticket-consumed'; }
>;
type AuthIssuedSessionReceipt = Extract<AuthMutationResult, { kind: 'session-issued'; }>;

interface ComputeAuthSessionMutationInput {
    readonly kind: AuthSessionMutationCommand['kind'];
    readonly command: AuthSessionMutationCommand;
    readonly read: AuthMutationRead;
    readonly serviceId: string;
}

interface ToConsumedAuthSessionResultInput {
    readonly kind: 'ws-ticket-consumed' | 'agent-ticket-consumed';
    readonly requestId: string;
    readonly session: PersistedAuthSession;
    readonly accessTokenDigest: string;
}

export function computeAuthSessionMutation(
    input: ComputeAuthSessionMutationInput
): AuthMutationComputed {
    switch (input.kind) {
        case 'issue-session':
            return computeIssueAuthSession(
                input.command as IssueAuthSessionCommand,
                input.read as Extract<AuthMutationRead, { kind: 'issue-session'; }>
            );
        case 'logout-session':
            return computeLogoutAuthSession(
                input.command as LogoutAuthSessionCommand,
                input.read as Extract<AuthMutationRead, { kind: 'logout-session'; }>,
                input.serviceId
            );
    }
}

export function toConsumedAuthSessionResult(
    input: ToConsumedAuthSessionResultInput
): AuthConsumedSessionReceipt {
    return {
        requestId: input.requestId,
        kind: input.kind,
        clientId: input.session.clientId,
        username: input.session.username,
        sessionId: input.session.sessionId,
        accessTokenDigest: input.accessTokenDigest,
        issuedAtEpochMs: input.session.issuedAtEpochMs,
        expiresAtEpochMs: input.session.expiresAtEpochMs
    };
}

export function requireConsumedAuthSession(
    entry: RuntimeStateEntryValue<PersistedAuthSession> | null,
    message: string
): PersistedAuthSession {
    if (!entry) {
        throw new AuthMutationRejectedError(message, 404);
    }
    return entry.value;
}

function computeIssueAuthSession(
    command: IssueAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-session'; }>
): AuthMutationComputed {
    const session = decodePersistedAuthSession(command.session);
    requireIssueSessionLifecycle(command.capturedAtEpochMs, session);
    return {
        command,
        read,
        sessions: [{ session }],
        agentTickets: [],
        logoutOutbox: null,
        result: toSessionReceipt(session, command.requestId),
        outcome: isMatchingSessionRead(read, session) ? 'replay' : 'write'
    };
}

function computeLogoutAuthSession(
    command: LogoutAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'logout-session'; }>,
    serviceId: string
): AuthMutationComputed {
    const result = { requestId: command.requestId, loggedOut: true };
    const outcome = read.bySession === null && read.byToken === null ? 'no-op' : 'write';
    const logoutOutbox = read.bySession ? toAuthLogoutOutbox(command, serviceId) : null;
    return {
        command,
        read,
        sessions: [],
        agentTickets: [],
        logoutOutbox,
        result,
        outcome
    };
}

function isMatchingSessionRead(read: AuthMutationRead, session: PersistedAuthSession): boolean {
    return (
        (read.kind === 'issue-session' || read.kind === 'logout-session') &&
        read.byToken !== null &&
        read.bySession !== null &&
        equalAuthJson(read.byToken.value, session) &&
        equalAuthJson(read.bySession.value, session)
    );
}

function toSessionReceipt(
    session: PersistedAuthSession,
    requestId: string
): AuthIssuedSessionReceipt {
    return {
        requestId,
        kind: 'session-issued',
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: session.accessTokenDigest,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}
