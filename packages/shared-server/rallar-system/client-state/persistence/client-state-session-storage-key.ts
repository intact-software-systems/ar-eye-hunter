import type { ClientSessionRef } from '@shared/api/client-types.ts';

import { clientStateInstanceStorageKey } from './client-state-instance-storage-key.ts';
import {
    compareClientStateStorageKeys,
    decodeClientStateStorageKey,
    encodeClientStateStorageKeyPart,
    readDecodedClientStateStorageKeyPart
} from './client-state-storage-key-codec.ts';

export function clientStateSessionStorageKey(ref: ClientSessionRef): string {
    return `${clientStateInstanceStorageKey(ref)}:session=${encodeClientStateStorageKeyPart(ref.sessionId)}`;
}

export function compareClientStateSessionStorageKeys(
    left: ClientSessionRef,
    right: ClientSessionRef
): number {
    return compareClientStateStorageKeys(
        clientStateSessionStorageKey(left),
        clientStateSessionStorageKey(right)
    );
}

export function decodeClientSessionStorageKey(key: string): ClientSessionRef {
    const values = decodeClientStateStorageKey(key, ['app', 'ws', 'principal', 'instance', 'session']);
    return {
        applicationId: readDecodedClientStateStorageKeyPart(values, 0),
        workspaceId: readDecodedClientStateStorageKeyPart(values, 1),
        principalId: readDecodedClientStateStorageKeyPart(values, 2),
        clientInstanceId: readDecodedClientStateStorageKeyPart(values, 3),
        sessionId: readDecodedClientStateStorageKeyPart(values, 4)
    };
}
