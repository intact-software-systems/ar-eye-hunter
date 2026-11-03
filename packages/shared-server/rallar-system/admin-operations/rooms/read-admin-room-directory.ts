import type {
    AdminRoomDirectoryEntry,
    AdminRoomDirectoryRequest,
    AdminRoomDirectoryResponse
} from '@shared/api/admin-rooms/admin-room-directory.ts';
import { toGroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';

import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '../../group-state/persistence/group-state-runtime-namespaces.ts';
import { AdminStateCorruptionError } from '../postgres/admin-state-corruption-error.ts';
import { decodeAdminGroupRuntimeRow } from '../postgres/decode-admin-group-runtime-row.ts';

export namespace ReadAdminRoomDirectory {
    export interface Dependencies {
        readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntriesByPrefixPage'>;
        readonly nowEpochMs: () => number;
    }
}

export class ReadAdminRoomDirectory {
    private readonly dependencies: ReadAdminRoomDirectory.Dependencies;

    constructor(dependencies: ReadAdminRoomDirectory.Dependencies) {
        this.dependencies = dependencies;
    }

    async read(request: AdminRoomDirectoryRequest): Promise<AdminRoomDirectoryResponse> {
        assertDirectoryRequest(request);
        const prefix = `${groupStateScopeStorageKey(request.scope)}:`;
        const afterKey = request.afterGroupId === null
            ? undefined
            : groupStateGroupStorageKey({ ...request.scope, groupId: request.afterGroupId });
        const rows = await this.dependencies.repository.findEntriesByPrefixPage(GROUPS_NAMESPACE, prefix, {
            afterKey,
            limit: request.limit + 1
        });
        const observedAtEpochMs = this.dependencies.nowEpochMs();
        const page = rows.slice(0, request.limit);
        const entries = page.flatMap((row) => {
            const ref = decodeDirectoryRowIdentity(row.key, request.scope);
            return row.expireAtTimestamp <= observedAtEpochMs ? [] : toDirectoryEntry(row, ref);
        });
        return {
            scope: request.scope,
            observedAtEpochMs,
            completeness: entries.some((entry) => entry.status === 'invalid') ? 'partial' : 'complete',
            entries,
            nextAfterGroupId: rows.length > request.limit
                ? decodeDirectoryRowIdentity(page[page.length - 1].key, request.scope).groupId
                : null
        };
    }
}

function assertDirectoryRequest(request: AdminRoomDirectoryRequest): void {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new TypeError('Room directory limit must be an integer from 1 through 100');
    }
    if (request.afterGroupId !== null && request.afterGroupId.length === 0) {
        throw new TypeError('Room directory cursor must be a non-empty group identity');
    }
}

function decodeDirectoryRowIdentity(key: string, scope: GroupScope): GroupRef {
    try {
        const ref = decodeGroupStateGroupStorageKey(key);
        if (ref.applicationId === scope.applicationId && ref.workspaceId === scope.workspaceId) {
            return ref;
        }
    }
    catch {
        // A corrupt storage identity cannot authorize even a diagnostic row.
    }
    throw new AdminStateCorruptionError('Room directory storage identity is invalid');
}

function toDirectoryEntry(row: RuntimeStateEntry, ref: GroupRef): readonly AdminRoomDirectoryEntry[] {
    try {
        const { value } = decodeAdminGroupRuntimeRow('group', { store_key: row.key, store_value: row.value }, ref);
        const directoryListing = toGroupDirectoryListing(value.metadata);
        if (directoryListing === null) {
            return [{ status: 'invalid', roomRef: ref, reason: 'invalid-room-record' }];
        }
        if (value.status === 'deleted') {
            return [];
        }
        return [{
            status: 'valid',
            room: {
                roomRef: ref,
                displayName: value.displayName,
                kind: value.kind,
                status: value.status,
                joinMode: value.joinMode,
                directoryListing,
                activeMemberCount: value.activeMemberCount,
                maxMembers: value.maxMembers,
                expiresAtEpochMs: value.expiresAtEpochMs
            }
        }];
    }
    catch (error) {
        if (!(error instanceof AdminStateCorruptionError)) {
            throw error;
        }
        return [{ status: 'invalid', roomRef: ref, reason: 'invalid-room-record' }];
    }
}
