import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupRef
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStateMemberStorageKey,
    decodeGroupStatePresenceSessionStorageKey
} from '../../group-state/persistence/group-state-storage-keys.ts';
import { validatePersistedGroupPresenceSession } from '../../group-state/persistence/validate-persisted-group-presence.ts';
import {
    validatePersistedGroup,
    validatePersistedGroupMember
} from '../../group-state/persistence/validate-persisted-group.ts';

import { AdminStateCorruptionError } from './admin-state-corruption-error.ts';

export interface PSqlAdminRuntimeStateRow {
    readonly store_key: string;
    readonly store_value: string;
}

export interface AdminGroupStateRuntimeRow {
    readonly kind: 'group';
    readonly ref: GroupRef;
    readonly value: Group;
}

export interface AdminGroupMemberRuntimeRow {
    readonly kind: 'member';
    readonly ref: GroupRef & { readonly principalId: string };
    readonly value: GroupMember;
}

export interface AdminGroupSessionRuntimeRow {
    readonly kind: 'session';
    readonly ref: GroupRef & { readonly sessionId: string };
    readonly value: GroupPresenceSession;
}

export type AdminGroupRuntimeRow =
    | AdminGroupStateRuntimeRow
    | AdminGroupMemberRuntimeRow
    | AdminGroupSessionRuntimeRow;

export function decodeAdminGroupRuntimeRow(
    kind: 'group',
    row: PSqlAdminRuntimeStateRow,
    scope?: StateScope
): AdminGroupStateRuntimeRow;
export function decodeAdminGroupRuntimeRow(
    kind: 'member',
    row: PSqlAdminRuntimeStateRow,
    scope?: StateScope
): AdminGroupMemberRuntimeRow;
export function decodeAdminGroupRuntimeRow(
    kind: 'session',
    row: PSqlAdminRuntimeStateRow,
    scope?: StateScope
): AdminGroupSessionRuntimeRow;

export function decodeAdminGroupRuntimeRow(
    kind: AdminGroupRuntimeRow['kind'],
    row: PSqlAdminRuntimeStateRow,
    scope?: StateScope
): AdminGroupRuntimeRow {
    try {
        switch (kind) {
            case 'group': {
                const ref = decodeGroupStateGroupStorageKey(row.store_key);
                requireScope(ref, scope, row.store_key);
                const value = JSON.parse(row.store_value);
                validatePersistedGroup(value, ref);
                return { kind, ref, value };
            }
            case 'member': {
                const ref = decodeGroupStateMemberStorageKey(row.store_key);
                requireScope(ref, scope, row.store_key);
                const value = JSON.parse(row.store_value);
                validatePersistedGroupMember(value, ref);
                if (value.principalId !== ref.principalId) {
                    throw new TypeError(`Stored group member identity differs from its slot: ${row.store_key}`);
                }
                return { kind, ref, value };
            }
            case 'session': {
                const ref = decodeGroupStatePresenceSessionStorageKey(row.store_key);
                requireScope(ref, scope, row.store_key);
                const value = JSON.parse(row.store_value);
                validatePersistedGroupPresenceSession(value, ref);
                if (value.sessionId !== ref.sessionId) {
                    throw new TypeError(`Stored group session identity differs from its slot: ${row.store_key}`);
                }
                return { kind, ref, value };
            }
        }
    }
    catch (error) {
        throw new AdminStateCorruptionError(
            error instanceof Error ? error.message : 'Stored group runtime row is invalid'
        );
    }
}

function requireScope(ref: GroupRef, scope: StateScope | undefined, storageKey: string): void {
    if (
        scope !== undefined &&
        (ref.applicationId !== scope.applicationId || ref.workspaceId !== scope.workspaceId)
    ) {
        throw new TypeError(`Stored group runtime identity differs from its scope: ${storageKey}`);
    }
}
