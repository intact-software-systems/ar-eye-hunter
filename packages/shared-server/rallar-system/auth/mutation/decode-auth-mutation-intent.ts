import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodePersistedAuthSession } from '../persistence/auth-persistence-contracts.ts';
import type { AuthMutationIntent } from './auth-mutation-contracts.ts';

type AuthMutationIntentCandidate = JsonWireValue | AuthMutationIntent;

export function decodeAuthMutationIntent(input: AuthMutationIntentCandidate): AuthMutationIntent {
    const intent = requireRecord(input, 'Auth mutation intent');
    if (intent.version !== 1) {
        throw new TypeError('Auth mutation intent version is invalid');
    }
    requireString(intent.requestId, 'Auth mutation requestId');
    assertNoPlaintextAuthFields(intent);
    validateAuthMutationIntent(intent);
    return structuredClone(intent) as AuthMutationIntent;
}

function validateAuthMutationIntent(intent: JsonWireObject): void {
    switch (intent.kind) {
        case 'register-user':
            requireExactKeys(intent, ['version', 'kind', 'requestId', 'registration']);
            validatePreparedRegistration(intent.registration);
            return;
        case 'issue-session':
            requireExactKeys(intent, [
                'version',
                'kind',
                'requestId',
                'authority',
                'clientId',
                'username',
                'ttlMs'
            ]);
            validateSessionAuthority(intent.authority);
            requireString(intent.clientId, 'Auth session clientId');
            requireString(intent.username, 'Auth session username');
            requirePositiveInteger(intent.ttlMs, 'Auth session ttlMs');
            return;
        case 'logout-session':
            requireExactKeys(intent, ['version', 'kind', 'requestId', 'expected']);
            decodePersistedAuthSession(intent.expected);
            return;
        case 'issue-ws-ticket':
            requireExactKeys(intent, ['version', 'kind', 'requestId', 'authority', 'ttlMs']);
            decodePersistedAuthSession(intent.authority);
            requirePositiveInteger(intent.ttlMs, 'Auth websocket ticket ttlMs');
            return;
        case 'consume-ws-ticket':
            requireExactKeys(intent, [
                'version',
                'kind',
                'requestId',
                'ticketDigest',
                'expectedSessionId'
            ]);
            requireString(intent.ticketDigest, 'Auth websocket ticket digest');
            requireString(intent.expectedSessionId, 'Auth websocket expected sessionId');
            return;
        case 'issue-agent-tickets':
            requireExactKeys(intent, [
                'version',
                'kind',
                'requestId',
                'authority',
                'ticketTtlMs',
                'agentIds'
            ]);
            decodePersistedAuthSession(intent.authority);
            requirePositiveInteger(intent.ticketTtlMs, 'Auth agent ticket ttlMs');
            validateAgentIds(intent.agentIds);
            return;
        case 'consume-agent-ticket':
            requireExactKeys(intent, ['version', 'kind', 'requestId', 'ticketDigest']);
            requireString(intent.ticketDigest, 'Auth agent ticket digest');
            return;
        default:
            throw new TypeError('Auth mutation intent kind is invalid');
    }
}

function validatePreparedRegistration(input: JsonWireValue): void {
    const registration = requireRecord(input, 'Prepared auth registration');
    requireExactKeys(registration, [
        'username',
        'normalizedUsername',
        'displayName',
        'passwordHash',
        'passwordSalt',
        'passwordAlgorithm',
        'passwordIterations',
        'roles',
        'status'
    ]);
    for (const field of ['username', 'normalizedUsername', 'passwordHash', 'passwordSalt'] as const) {
        requireString(registration[field], `Prepared auth registration ${field}`);
    }
    if (registration.displayName !== null) {
        requireString(registration.displayName, 'Prepared auth registration displayName');
    }
    if (registration.passwordAlgorithm !== 'pbkdf2-sha256') {
        throw new TypeError('Prepared auth registration passwordAlgorithm is invalid');
    }
    requirePositiveInteger(
        registration.passwordIterations,
        'Prepared auth registration passwordIterations'
    );
    if (
        !Array.isArray(registration.roles) ||
        registration.roles.some((role) => typeof role !== 'string' || role.length === 0)
    ) {
        throw new TypeError('Prepared auth registration roles are invalid');
    }
    if (registration.status !== 'active') {
        throw new TypeError('Prepared auth registration status is invalid');
    }
}

function validateSessionAuthority(input: JsonWireValue): void {
    const authority = requireRecord(input, 'Auth session authority');
    requireString(authority.clientId, 'Auth session authority clientId');
    requireString(authority.normalizedUsername, 'Auth session authority normalizedUsername');
    if (authority.kind === 'registered-user') {
        requireExactKeys(authority, ['kind', 'clientId', 'normalizedUsername', 'userRevision']);
        requireNonNegativeInteger(authority.userRevision, 'Auth session authority userRevision');
        return;
    }
    if (authority.kind === 'static-client') {
        requireExactKeys(authority, ['kind', 'clientId', 'normalizedUsername']);
        return;
    }
    throw new TypeError('Auth session authority kind is invalid');
}

function validateAgentIds(input: JsonWireValue): void {
    if (
        !Array.isArray(input) ||
        input.length === 0 ||
        input.some((agentId) => typeof agentId !== 'string' || agentId.length === 0)
    ) {
        throw new TypeError('Auth agent IDs must be a non-empty string array');
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
            throw new TypeError(`Auth mutation intent contains forbidden plaintext field: ${key}`);
        }
        assertNoPlaintextAuthFields(nested);
    }
}

function requireRecord(value: AuthMutationIntentCandidate, label: string): JsonWireObject {
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
        throw new TypeError(`Auth mutation intent fields are invalid: ${actual.join(',')}`);
    }
}

function requireString(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
}

function requirePositiveInteger(value: JsonWireValue, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireNonNegativeInteger(value: JsonWireValue, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}
