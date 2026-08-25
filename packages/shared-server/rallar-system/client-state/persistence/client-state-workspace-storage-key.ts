import { encodeClientStateStorageKeyPart } from './client-state-storage-key-codec.ts';

export function clientStateWorkspaceStorageKey(workspaceId: string): string {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new TypeError('Client-state workspaceId must be a nonempty string');
    }
    return encodeClientStateStorageKeyPart(workspaceId);
}
