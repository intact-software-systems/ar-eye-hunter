import type { ClientScope } from '@shared/api/client-types.ts';

import { encodeClientStateStorageKeyPart } from './client-state-storage-key-codec.ts';
import { clientStateWorkspaceStorageKey } from './client-state-workspace-storage-key.ts';

export function clientStateScopeStorageKey(scope: ClientScope): string {
    if (scope.applicationId.length === 0) {
        throw new TypeError('Client-state applicationId must be a nonempty string');
    }
    return [
        `app=${encodeClientStateStorageKeyPart(scope.applicationId)}`,
        `ws=${clientStateWorkspaceStorageKey(scope.workspaceId)}`
    ].join(':');
}

export function clientStateScopeStorageKeyPrefix(scope: ClientScope): string {
    return `${clientStateScopeStorageKey(scope)}:`;
}
