import type { GroupDirectoryListing } from '../group-directory/group-directory-listing.ts';
import type {
    Group,
    GroupRef,
    GroupScope
} from '../group-types.ts';

export interface AdminRoomSummary {
    readonly roomRef: GroupRef;
    readonly displayName: string;
    readonly kind: Group['kind'];
    readonly status: 'active' | 'archived';
    readonly joinMode: Group['joinMode'];
    readonly directoryListing: GroupDirectoryListing;
    readonly activeMemberCount: number;
    readonly maxMembers: number | null;
    readonly expiresAtEpochMs: number | null;
}

export type AdminRoomDirectoryEntry =
    | { readonly status: 'valid'; readonly room: AdminRoomSummary; }
    | {
        readonly status: 'invalid';
        readonly roomRef: GroupRef;
        readonly reason: 'invalid-room-record';
    };

export interface AdminRoomDirectoryRequest {
    readonly scope: GroupScope;
    readonly limit: number;
    readonly afterGroupId: string | null;
}

export interface AdminRoomDirectoryResponse {
    readonly scope: GroupScope;
    readonly observedAtEpochMs: number;
    readonly completeness: 'complete' | 'partial';
    readonly entries: readonly AdminRoomDirectoryEntry[];
    readonly nextAfterGroupId: string | null;
}
