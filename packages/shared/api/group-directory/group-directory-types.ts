import type { GroupLifecycleState } from '../group-lifecycle/group-lifecycle-policy.ts';
import type { Group, GroupRef } from '../group-types.ts';

export interface GroupDirectoryEntry {
    readonly groupRef: GroupRef;
    readonly displayName: string;
    readonly kind: Group['kind'];
    readonly joinMode: Group['joinMode'];
    readonly memberCount: number;
    readonly onlineMemberCount: number;
    readonly maxMembers: number | null;
    readonly isFull: boolean;
    readonly lifecycleState: GroupLifecycleState;
}

export interface GroupDirectoryPage {
    readonly entries: readonly GroupDirectoryEntry[];
    readonly nextCursor: string | null;
}

/** Sparse caller input; the server applies the contractual defaults. */
export interface GroupDirectoryRequest {
    readonly kind?: Group['kind'];
    readonly q?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly includeEmpty?: boolean;
}

export const GROUP_DIRECTORY_DEFAULT_LIMIT = 50;
export const GROUP_DIRECTORY_MAX_LIMIT = 200;
