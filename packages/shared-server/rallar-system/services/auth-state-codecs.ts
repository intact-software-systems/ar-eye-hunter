import {
    decodePersistedAgentSessionTicket,
    decodePersistedAuthSession,
    decodePersistedWebSocketTicket,
} from '../repositories/AuthSessionRepository.ts';
import type { AuthMutationCommand, AuthMutationResult } from './auth-state-contracts.ts';
import { requireIssueSessionLifecycle } from './auth-session-lifecycle.ts';

export function decodeAuthMutationCommand(input: unknown): AuthMutationCommand {
    const command = requireRecord(input, 'Auth mutation command');
    if (command.version !== 1) throw new TypeError('Auth mutation command version is invalid');
    requireString(command.requestId, 'Auth mutation requestId');
    requireTimestamp(command.capturedAtEpochMs, 'Auth mutation capturedAtEpochMs');
    switch (command.kind) {
        case 'register-user':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'user',
            ]);
            validateAuthUserContract(command.user);
            break;
        case 'issue-session':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'authority',
                'session',
            ]);
            validateSessionAuthority(command.authority);
            requireIssueSessionLifecycle(
                command.capturedAtEpochMs as number,
                decodePersistedAuthSession(command.session),
            );
            break;
        case 'logout-session':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'expected',
            ]);
            decodePersistedAuthSession(command.expected);
            break;
        case 'issue-ws-ticket':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'ticketRecord',
            ]);
            decodePersistedWebSocketTicket(command.ticketRecord);
            break;
        case 'consume-ws-ticket':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'ticketDigest',
                'expectedSessionId',
            ]);
            requireString(command.ticketDigest, 'Auth websocket ticket digest');
            requireString(command.expectedSessionId, 'Auth websocket expected sessionId');
            break;
        case 'issue-agent-tickets':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'authority',
                'tickets',
            ]);
            decodePersistedAuthSession(command.authority);
            validateAgentTicketCommands(command.tickets);
            break;
        case 'consume-agent-ticket':
            requireExactKeys(command, [
                'version',
                'kind',
                'requestId',
                'capturedAtEpochMs',
                'ticketDigest',
            ]);
            requireString(command.ticketDigest, 'Auth agent ticket digest');
            break;
        default:
            throw new TypeError('Auth mutation command kind is invalid');
    }
    assertNoPlaintextAuthFields(command);
    return structuredClone(command) as AuthMutationCommand;
}

export function decodeAuthMutationResult(input: unknown): AuthMutationResult {
    const result = requireRecord(input, 'Auth mutation result');
    requireString(result.requestId, 'Auth mutation result requestId');
    if ('registeredAtEpochMs' in result) {
        requireExactKeys(result, [
            'requestId',
            'clientId',
            'username',
            'displayName',
            'registeredAtEpochMs',
        ]);
        requireString(result.clientId, 'Auth result clientId');
        requireString(result.username, 'Auth result username');
        if (result.displayName !== null) {
            requireString(result.displayName, 'Auth result displayName');
        }
        requireTimestamp(result.registeredAtEpochMs, 'Auth result registeredAtEpochMs');
    } else if ('loggedOut' in result) {
        requireExactKeys(result, ['requestId', 'loggedOut']);
        if (result.loggedOut !== true) throw new TypeError('Auth logout result is invalid');
    } else {
        validateDiscriminatedResult(result);
    }
    assertNoPlaintextAuthFields(result);
    return structuredClone(result) as AuthMutationResult;
}

function validateDiscriminatedResult(result: Readonly<Record<string, unknown>>): void {
    switch (result.kind) {
        case 'session-issued':
        case 'ws-ticket-consumed':
        case 'agent-ticket-consumed':
            validateSessionResult(result);
            return;
        case 'ws-ticket-issued':
            requireExactKeys(result, [
                'requestId',
                'kind',
                'ticketDigest',
                'sessionId',
                'issuedAtEpochMs',
                'expiresAtEpochMs',
            ]);
            requireString(result.ticketDigest, 'Auth result ticketDigest');
            requireString(result.sessionId, 'Auth result sessionId');
            validateResultLifecycle(result);
            return;
        case 'agent-tickets-issued':
            requireExactKeys(result, ['requestId', 'kind', 'tickets']);
            if (!Array.isArray(result.tickets) || result.tickets.length === 0) {
                throw new TypeError('Auth result tickets must be a non-empty array');
            }
            for (const inputTicket of result.tickets) validateAgentTicketResult(inputTicket);
            return;
        default:
            throw new TypeError('Auth mutation result kind is invalid');
    }
}

function validateSessionAuthority(input: unknown): void {
    const authority = requireRecord(input, 'Auth session authority');
    requireString(authority.clientId, 'Auth session authority clientId');
    requireString(authority.normalizedUsername, 'Auth session authority normalizedUsername');
    if (authority.kind === 'registered-user') {
        requireExactKeys(authority, [
            'kind',
            'clientId',
            'normalizedUsername',
            'userRevision',
        ]);
        requireTimestamp(authority.userRevision, 'Auth session authority userRevision');
    } else if (authority.kind === 'static-client') {
        requireExactKeys(authority, ['kind', 'clientId', 'normalizedUsername']);
    } else {
        throw new TypeError('Auth session authority kind is invalid');
    }
}

function validateAgentTicketCommands(input: unknown): void {
    if (!Array.isArray(input) || input.length === 0) {
        throw new TypeError('Auth agent tickets must be a non-empty array');
    }
    for (const inputTicket of input) {
        const ticket = requireRecord(inputTicket, 'Auth agent ticket command');
        requireExactKeys(ticket, [
            'agentId',
            'sessionId',
            'accessTokenDigest',
            'ticketDigest',
            'clientId',
            'username',
            'issuedAtEpochMs',
            'sessionExpiresAtEpochMs',
            'ticketExpiresAtEpochMs',
        ]);
        for (
            const field of [
                'agentId',
                'sessionId',
                'accessTokenDigest',
                'ticketDigest',
                'clientId',
                'username',
            ] as const
        ) requireString(ticket[field], `Auth agent ticket ${field}`);
        for (
            const field of [
                'issuedAtEpochMs',
                'sessionExpiresAtEpochMs',
                'ticketExpiresAtEpochMs',
            ] as const
        ) requireTimestamp(ticket[field], `Auth agent ticket ${field}`);
        const issuedAtEpochMs = ticket.issuedAtEpochMs as number;
        const sessionExpiresAtEpochMs = ticket.sessionExpiresAtEpochMs as number;
        decodePersistedAgentSessionTicket({
            ticketDigest: ticket.ticketDigest,
            accessTokenDigest: ticket.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            agentId: ticket.agentId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
        });
        if (issuedAtEpochMs >= sessionExpiresAtEpochMs) {
            throw new TypeError('Auth agent session lifecycle is invalid');
        }
    }
}

function validateAgentTicketResult(input: unknown): void {
    const ticket = requireRecord(input, 'Auth result agent ticket');
    requireExactKeys(ticket, [
        'agentId',
        'ticketDigest',
        'sessionId',
        'issuedAtEpochMs',
        'expiresAtEpochMs',
    ]);
    requireString(ticket.agentId, 'Auth result agentId');
    requireString(ticket.ticketDigest, 'Auth result ticketDigest');
    requireString(ticket.sessionId, 'Auth result sessionId');
    validateResultLifecycle(ticket);
}

function validateSessionResult(result: Readonly<Record<string, unknown>>): void {
    requireExactKeys(result, [
        'requestId',
        'kind',
        'clientId',
        'username',
        'sessionId',
        'accessTokenDigest',
        'issuedAtEpochMs',
        'expiresAtEpochMs',
    ]);
    for (
        const field of [
            'clientId',
            'username',
            'sessionId',
            'accessTokenDigest',
        ] as const
    ) requireString(result[field], `Auth result ${field}`);
    validateResultLifecycle(result);
}

function validateResultLifecycle(result: Readonly<Record<string, unknown>>): void {
    requireTimestamp(result.issuedAtEpochMs, 'Auth result issuedAtEpochMs');
    requireTimestamp(result.expiresAtEpochMs, 'Auth result expiresAtEpochMs');
    if (result.issuedAtEpochMs >= result.expiresAtEpochMs) {
        throw new TypeError('Auth result lifecycle is invalid');
    }
}

function validateAuthUserContract(input: unknown): void {
    const user = requireRecord(input, 'Auth user');
    requireExactKeys(user, [
        'clientId',
        'username',
        'normalizedUsername',
        'displayName',
        'passwordHash',
        'passwordSalt',
        'passwordAlgorithm',
        'passwordIterations',
        'roles',
        'status',
        'createdAtEpochMs',
        'updatedAtEpochMs',
    ]);
    for (
        const field of [
            'clientId',
            'username',
            'normalizedUsername',
            'passwordHash',
            'passwordSalt',
        ] as const
    ) requireString(user[field], `Auth user ${field}`);
    if (user.displayName !== null) requireString(user.displayName, 'Auth user displayName');
    if (user.passwordAlgorithm !== 'pbkdf2-sha256') {
        throw new TypeError('Auth user passwordAlgorithm is invalid');
    }
    requireTimestamp(user.passwordIterations, 'Auth user passwordIterations');
    requireTimestamp(user.createdAtEpochMs, 'Auth user createdAtEpochMs');
    requireTimestamp(user.updatedAtEpochMs, 'Auth user updatedAtEpochMs');
    if (
        !Array.isArray(user.roles) ||
        user.roles.some((role) => typeof role !== 'string' || role.length === 0)
    ) throw new TypeError('Auth user roles are invalid');
    if (user.status !== 'active' && user.status !== 'disabled') {
        throw new TypeError('Auth user status is invalid');
    }
}

function assertNoPlaintextAuthFields(value: unknown): void {
    if (Array.isArray(value)) {
        for (const item of value) assertNoPlaintextAuthFields(item);
        return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
        if (key === 'password' || key === 'accessToken' || key === 'ticket') {
            throw new TypeError(`Auth mutation command contains forbidden plaintext field: ${key}`);
        }
        assertNoPlaintextAuthFields(nested);
    }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
    if (
        typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`Auth mutation fields are invalid: ${actual.join(',')}`);
    }
}

function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}
