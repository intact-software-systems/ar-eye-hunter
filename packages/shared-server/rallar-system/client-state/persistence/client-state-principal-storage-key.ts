import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import { clientStateScopeStorageKey } from './client-state-scope-storage-key.ts';
import {
    decodeClientStateStorageKey,
    encodeClientStateStorageKeyPart,
    readDecodedClientStateStorageKeyPart
} from './client-state-storage-key-codec.ts';

export function clientStatePrincipalStorageKey(ref: ClientPrincipalRef): string {
    return `${clientStateScopeStorageKey(ref)}:principal=${encodeClientStateStorageKeyPart(ref.principalId)}`;
}

export function decodeClientPrincipalStorageKey(key: string): ClientPrincipalRef {
    const values = decodeClientStateStorageKey(key, ['app', 'ws', 'principal']);
    return {
        applicationId: readDecodedClientStateStorageKeyPart(values, 0),
        workspaceId: readDecodedClientStateStorageKeyPart(values, 1),
        principalId: readDecodedClientStateStorageKeyPart(values, 2)
    };
}
