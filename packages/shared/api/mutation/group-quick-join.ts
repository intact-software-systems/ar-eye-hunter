import type { GroupDirectoryRequest } from '../group-directory/group-directory-types.ts';
import type { GroupSnapshot } from '../group-types.ts';

/** Sparse selection input; admission never creates a room or requests approval. */
export interface QuickJoinGroupRequest extends Pick<GroupDirectoryRequest, 'kind' | 'q' | 'includeEmpty'> {
    readonly requestId: string;
}

export type QuickJoinGroupResult =
    | Readonly<{ status: 'joined'; snapshot: GroupSnapshot; }>
    | Readonly<{ status: 'unavailable'; }>;
