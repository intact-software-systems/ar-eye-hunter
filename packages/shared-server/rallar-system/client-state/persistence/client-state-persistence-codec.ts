import type {
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientSession,
    ClientSessionRef
} from '@shared/api/client-types.ts';

import {
    validatePersistedClientEvent,
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession
} from './validate-persisted-client-state.ts';

export function decodePersistedClientPrincipal(
    value: unknown,
    expected: ClientPrincipalRef
): ClientPrincipal {
    validatePersistedClientPrincipal(value, expected);
    return structuredClone(value);
}

export function decodePersistedClientInstance(
    value: unknown,
    expected: ClientInstanceRef
): ClientInstance {
    validatePersistedClientInstance(value, expected);
    return structuredClone(value);
}

export function decodePersistedClientSession(
    value: unknown,
    expected: ClientSessionRef
): ClientSession {
    validatePersistedClientSession(value, expected);
    return structuredClone(value);
}

export function decodePersistedClientEvent(
    value: unknown,
    expected: ClientPrincipalRef
): ClientEvent {
    validatePersistedClientEvent(value, expected);
    return structuredClone(value);
}
