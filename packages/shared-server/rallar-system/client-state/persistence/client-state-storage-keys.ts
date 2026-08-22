import type { ClientInstanceRef, ClientPrincipalRef, ClientScope, ClientSessionRef } from '@shared/api/client-types.ts';

export function clientStatePrincipalStorageKey(ref: ClientPrincipalRef): string {
    return [
        `app=${encodeURIComponent(ref.applicationId)}`,
        `ws=${clientStateWorkspaceStorageKey(ref.workspaceId)}`,
        `principal=${encodeURIComponent(ref.principalId)}`
    ].join(':');
}

export function clientStateWorkspaceStorageKey(workspaceId: string): string {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new TypeError('Client-state workspaceId must be a nonempty string');
    }
    return workspaceId === '_' ? '%5F' : encodeURIComponent(workspaceId);
}

export function clientStateIdempotencyStorageKey(
    ref: ClientPrincipalRef,
    requestId: string
): string {
    return `${clientStatePrincipalStorageKey(ref)}:request=${encodeURIComponent(requestId)}`;
}

export function clientStateInstanceStorageKey(ref: ClientInstanceRef): string {
    return `${clientStatePrincipalStorageKey(ref)}:instance=${
        encodeURIComponent(
            ref.clientInstanceId
        )
    }`;
}

export function clientStateSessionStorageKey(ref: ClientSessionRef): string {
    return `${clientStateInstanceStorageKey(ref)}:session=${encodeURIComponent(ref.sessionId)}`;
}

export function compareClientStateInstanceStorageKeys(
    left: ClientInstanceRef,
    right: ClientInstanceRef
): number {
    return compareCanonicalStorageKeys(
        clientStateInstanceStorageKey(left),
        clientStateInstanceStorageKey(right)
    );
}

export function compareClientStateSessionStorageKeys(
    left: ClientSessionRef,
    right: ClientSessionRef
): number {
    return compareCanonicalStorageKeys(
        clientStateSessionStorageKey(left),
        clientStateSessionStorageKey(right)
    );
}

export function decodeClientPrincipalStorageKey(key: string): ClientPrincipalRef {
    const values = decodeClientKey(key, ['app', 'ws', 'principal']);
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    return { applicationId, workspaceId, principalId };
}

export function decodeClientInstanceStorageKey(key: string): ClientInstanceRef {
    const values = decodeClientKey(key, ['app', 'ws', 'principal', 'instance']);
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const clientInstanceId = decodedClientKeyPart(values, 3);
    return { applicationId, workspaceId, principalId, clientInstanceId };
}

export function decodeClientSessionStorageKey(key: string): ClientSessionRef {
    const values = decodeClientKey(key, ['app', 'ws', 'principal', 'instance', 'session']);
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const clientInstanceId = decodedClientKeyPart(values, 3);
    const sessionId = decodedClientKeyPart(values, 4);
    return {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId,
        sessionId
    };
}

export function decodeClientIdempotencyStorageKey(
    key: string
): ClientPrincipalRef & Readonly<{ requestId: string; }> {
    const values = decodeClientKey(key, ['app', 'ws', 'principal', 'request']);
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const requestId = decodedClientKeyPart(values, 3);
    return { applicationId, workspaceId, principalId, requestId };
}

export function assertExpectedClientStorageIdentity(
    actual: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    expected: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    label: string
): void {
    if (
        actual.applicationId !== expected.applicationId ||
        actual.workspaceId !== expected.workspaceId ||
        ('principalId' in expected &&
            (!('principalId' in actual) || actual.principalId !== expected.principalId)) ||
        ('clientInstanceId' in expected &&
            (!('clientInstanceId' in actual) || actual.clientInstanceId !== expected.clientInstanceId)) ||
        ('sessionId' in expected &&
            (!('sessionId' in actual) || actual.sessionId !== expected.sessionId))
    ) {
        throw new TypeError(`Stored client ${label} identity differs from its canonical slot`);
    }
}

function compareCanonicalStorageKeys(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

function decodeClientKey(key: string, names: readonly string[]): readonly string[] {
    const segments = key.split(':');
    if (segments.length !== names.length) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    return names.map((name, index) => {
        const prefix = `${name}=`;
        const segment = segments[index];
        if (!segment?.startsWith(prefix)) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        const encoded = segment.slice(prefix.length);
        const decoded = decodeURIComponent(encoded);
        const canonical = name === 'ws' ? clientStateWorkspaceStorageKey(decoded) : encodeURIComponent(decoded);
        if (decoded.length === 0 || canonical !== encoded) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        return decoded;
    });
}

function decodedClientKeyPart(values: readonly string[], index: number): string {
    const value = values[index];
    if (value === undefined) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    return value;
}
