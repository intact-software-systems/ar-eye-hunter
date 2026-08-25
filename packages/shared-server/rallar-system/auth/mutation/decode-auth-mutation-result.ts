import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AuthMutationResult } from './auth-mutation-contracts.ts';

export function decodeAuthMutationResult(input: unknown): AuthMutationResult {
    const result = requireRecord(
        decodeJsonWireValue(input, 'Auth mutation result'),
        'Auth mutation result'
    );
    requireString(result.requestId, 'Auth mutation result requestId');
    if ('registeredAtEpochMs' in result) {
        validateAuthRegistrationResult(result);
    }
    else if ('loggedOut' in result) {
        validateAuthLogoutResult(result);
    }
    else {
        validateDiscriminatedResult(result);
    }
    assertNoPlaintextAuthFields(result);
    return structuredClone(result) as AuthMutationResult;
}

function validateAuthRegistrationResult(result: JsonWireObject): void {
    requireExactKeys(result, [
        'requestId',
        'clientId',
        'username',
        'displayName',
        'registeredAtEpochMs'
    ]);
    requireString(result.clientId, 'Auth result clientId');
    requireString(result.username, 'Auth result username');
    if (result.displayName !== null) {
        requireString(result.displayName, 'Auth result displayName');
    }
    requireTimestamp(result.registeredAtEpochMs, 'Auth result registeredAtEpochMs');
}

function validateAuthLogoutResult(result: JsonWireObject): void {
    requireExactKeys(result, ['requestId', 'loggedOut']);
    if (result.loggedOut !== true) {
        throw new TypeError('Auth logout result is invalid');
    }
}

function validateDiscriminatedResult(result: JsonWireObject): void {
    switch (result.kind) {
        case 'session-issued':
        case 'ws-ticket-consumed':
        case 'agent-ticket-consumed':
            validateSessionResult(result);
            return;
        case 'ws-ticket-issued':
            validateWebSocketTicketIssuedResult(result);
            return;
        case 'agent-tickets-issued':
            validateAgentTicketsIssuedResult(result);
            return;
        default:
            throw new TypeError('Auth mutation result kind is invalid');
    }
}

function validateWebSocketTicketIssuedResult(result: JsonWireObject): void {
    requireExactKeys(result, [
        'requestId',
        'kind',
        'ticketDigest',
        'sessionId',
        'issuedAtEpochMs',
        'expiresAtEpochMs'
    ]);
    requireString(result.ticketDigest, 'Auth result ticketDigest');
    requireString(result.sessionId, 'Auth result sessionId');
    validateResultLifecycle(result);
}

function validateAgentTicketsIssuedResult(result: JsonWireObject): void {
    requireExactKeys(result, ['requestId', 'kind', 'tickets']);
    if (!Array.isArray(result.tickets) || result.tickets.length === 0) {
        throw new TypeError('Auth result tickets must be a non-empty array');
    }
    for (const inputTicket of result.tickets) {
        validateAgentTicketResult(requireRecord(inputTicket, 'Auth result agent ticket'));
    }
}

function validateAgentTicketResult(ticket: JsonWireObject): void {
    requireExactKeys(ticket, [
        'agentId',
        'ticketDigest',
        'sessionId',
        'issuedAtEpochMs',
        'expiresAtEpochMs'
    ]);
    requireString(ticket.agentId, 'Auth result agentId');
    requireString(ticket.ticketDigest, 'Auth result ticketDigest');
    requireString(ticket.sessionId, 'Auth result sessionId');
    validateResultLifecycle(ticket);
}

function validateSessionResult(result: JsonWireObject): void {
    requireExactKeys(result, [
        'requestId',
        'kind',
        'clientId',
        'username',
        'sessionId',
        'accessTokenDigest',
        'issuedAtEpochMs',
        'expiresAtEpochMs'
    ]);
    for (const field of ['clientId', 'username', 'sessionId', 'accessTokenDigest'] as const) {
        requireString(result[field], `Auth result ${field}`);
    }
    validateResultLifecycle(result);
}

function validateResultLifecycle(result: JsonWireObject): void {
    requireTimestamp(result.issuedAtEpochMs, 'Auth result issuedAtEpochMs');
    requireTimestamp(result.expiresAtEpochMs, 'Auth result expiresAtEpochMs');
    if (result.issuedAtEpochMs >= result.expiresAtEpochMs) {
        throw new TypeError('Auth result lifecycle is invalid');
    }
}

function assertNoPlaintextAuthFields(value: JsonWireValue): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            assertNoPlaintextAuthFields(item);
        }
        return;
    }
    if (typeof value !== 'object' || value === null) {
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (key === 'password' || key === 'accessToken' || key === 'ticket') {
            throw new TypeError(`Auth mutation command contains forbidden plaintext field: ${key}`);
        }
        assertNoPlaintextAuthFields(nested);
    }
}

function requireRecord(value: JsonWireValue, label: string): JsonWireObject {
    if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return value as JsonWireObject;
}

function requireExactKeys(value: JsonWireObject, keys: readonly string[]): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`Auth mutation fields are invalid: ${actual.join(',')}`);
    }
}

function requireString(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
}

function requireTimestamp(value: JsonWireValue, label: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}
