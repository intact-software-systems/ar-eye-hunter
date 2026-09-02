import type { Group, GroupMember, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { decodeGroupStateGroupStorageKey } from '../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeGroupStateMemberStorageKey } from '../../group-state/persistence/membership/group-membership-storage-key.ts';
import { decodeGroupStatePresenceSessionStorageKey } from '../../group-state/persistence/presence/group-presence-storage-keys.ts';
import { validatePresenceSession } from '../../group-state/persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup, validateStoredMember } from '../../group-state/persistence/validate-persisted-group.ts';

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
    readonly ref: GroupRef & { readonly principalId: string; };
    readonly value: GroupMember;
}

export interface AdminGroupSessionRuntimeRow {
    readonly kind: 'session';
    readonly ref: GroupRef & { readonly sessionId: string; };
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
                const persistedGroupIssues = validateStoredGroup(value, ref);
                if (persistedGroupIssues.length > 0) {
                    throw persistedGroupIssues[0].cause;
                }
                return { kind, ref, value };
            }
            case 'member': {
                const ref = decodeGroupStateMemberStorageKey(row.store_key);
                requireScope(ref, scope, row.store_key);
                const value = JSON.parse(row.store_value);
                const persistedGroupMemberIssues = validateStoredMember(value, ref, 'Stored group member');
                if (persistedGroupMemberIssues.length > 0) {
                    throw persistedGroupMemberIssues[0].cause;
                }
                if (value.principalId !== ref.principalId) {
                    throw new TypeError(`Stored group member identity differs from its slot: ${row.store_key}`);
                }
                return { kind, ref, value };
            }
            case 'session': {
                const ref = decodeGroupStatePresenceSessionStorageKey(row.store_key);
                requireScope(ref, scope, row.store_key);
                const value = JSON.parse(row.store_value);
                const persistedGroupPresenceSessionIssues = validatePresenceSession(
                    value,
                    ref,
                    'Stored group presence session'
                );
                if (persistedGroupPresenceSessionIssues.length > 0) {
                    throw persistedGroupPresenceSessionIssues[0].cause;
                }
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
