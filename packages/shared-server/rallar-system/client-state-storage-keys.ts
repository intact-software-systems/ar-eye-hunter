import type {
    ClientInstanceRef,
    ClientPrincipalRef,
    ClientSessionRef,
} from '@shared/api/client-types.ts';

export function clientStatePrincipalStorageKey(ref: ClientPrincipalRef): string {
    return [
        `app=${encodeURIComponent(ref.applicationId)}`,
        `ws=${encodeURIComponent(ref.workspaceId ?? '_')}`,
        `principal=${encodeURIComponent(ref.principalId)}`,
    ].join(':');
}

export function clientStateIdempotencyStorageKey(
    ref: ClientPrincipalRef,
    requestId: string,
): string {
    return `${clientStatePrincipalStorageKey(ref)}:request=${encodeURIComponent(requestId)}`;
}

export function clientStateInstanceStorageKey(ref: ClientInstanceRef): string {
    return `${clientStatePrincipalStorageKey(ref)}:instance=${
        encodeURIComponent(ref.clientInstanceId)
    }`;
}

export function clientStateSessionStorageKey(ref: ClientSessionRef): string {
    return `${clientStateInstanceStorageKey(ref)}:session=${encodeURIComponent(ref.sessionId)}`;
}

export function compareClientStateInstanceStorageKeys(
    left: ClientInstanceRef,
    right: ClientInstanceRef,
): number {
    return compareCanonicalStorageKeys(
        clientStateInstanceStorageKey(left),
        clientStateInstanceStorageKey(right),
    );
}

export function compareClientStateSessionStorageKeys(
    left: ClientSessionRef,
    right: ClientSessionRef,
): number {
    return compareCanonicalStorageKeys(
        clientStateSessionStorageKey(left),
        clientStateSessionStorageKey(right),
    );
}

function compareCanonicalStorageKeys(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}
