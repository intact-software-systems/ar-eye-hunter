import type { ClientInstanceRef } from '@shared/api/client-types.ts';

import { clientStatePrincipalStorageKey } from './client-state-principal-storage-key.ts';
import {
    compareClientStateStorageKeys,
    decodeClientStateStorageKey,
    encodeClientStateStorageKeyPart,
    readDecodedClientStateStorageKeyPart
} from './client-state-storage-key-codec.ts';

export function clientStateInstanceStorageKey(ref: ClientInstanceRef): string {
    return `${clientStatePrincipalStorageKey(ref)}:instance=${
        encodeClientStateStorageKeyPart(
            ref.clientInstanceId
        )
    }`;
}

export function compareClientStateInstanceStorageKeys(
    left: ClientInstanceRef,
    right: ClientInstanceRef
): number {
    return compareClientStateStorageKeys(
        clientStateInstanceStorageKey(left),
        clientStateInstanceStorageKey(right)
    );
}

export function decodeClientInstanceStorageKey(key: string): ClientInstanceRef {
    const values = decodeClientStateStorageKey(key, ['app', 'ws', 'principal', 'instance']);
    return {
        applicationId: readDecodedClientStateStorageKeyPart(values, 0),
        workspaceId: readDecodedClientStateStorageKeyPart(values, 1),
        principalId: readDecodedClientStateStorageKeyPart(values, 2),
        clientInstanceId: readDecodedClientStateStorageKeyPart(values, 3)
    };
}
