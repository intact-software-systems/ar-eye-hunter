import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import { clientStatePrincipalStorageKey } from './client-state-principal-storage-key.ts';
import {
    decodeClientStateStorageKey,
    encodeClientStateStorageKeyPart,
    readDecodedClientStateStorageKeyPart
} from './client-state-storage-key-codec.ts';

export interface ClientStateIdempotencyStorageIdentity extends ClientPrincipalRef {
    readonly requestId: string;
}

export function clientStateIdempotencyStorageKey(
    ref: ClientPrincipalRef,
    requestId: string
): string {
    return `${clientStatePrincipalStorageKey(ref)}:request=${encodeClientStateStorageKeyPart(requestId)}`;
}

export function decodeClientIdempotencyStorageKey(
    key: string
): ClientStateIdempotencyStorageIdentity {
    const values = decodeClientStateStorageKey(key, ['app', 'ws', 'principal', 'request']);
    return {
        applicationId: readDecodedClientStateStorageKeyPart(values, 0),
        workspaceId: readDecodedClientStateStorageKeyPart(values, 1),
        principalId: readDecodedClientStateStorageKeyPart(values, 2),
        requestId: readDecodedClientStateStorageKeyPart(values, 3)
    };
}
