import type { QuickJoinGroupRequest, QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GroupDirectoryQuery } from '../directory/decode-group-directory-query.ts';

import type { GroupMutationAuthorityProof } from '../group-state-service-contracts.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationIngressFacts,
    GroupMutationSnapshotRead
} from '../mutation/group-mutation-contracts.ts';

export interface GroupQuickJoinInput {
    readonly scope: StateScope;
    readonly request: QuickJoinGroupRequest;
    readonly traceId: string;
}

export interface GroupQuickJoinCommand extends Pick<GroupDirectoryQuery, 'kind' | 'q' | 'includeEmpty'> {
    readonly scope: StateScope;
    readonly requestId: string;
    readonly actorPrincipalId: string;
    readonly actorSessionId: string;
}

export interface GroupQuickJoinIngress {
    readonly command: GroupQuickJoinCommand;
    readonly authorityProof: GroupMutationAuthorityProof;
    readonly facts: GroupMutationIngressFacts;
}

export interface GroupQuickJoinCandidate extends GroupMutationSnapshotRead {
    readonly command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }>;
}

export interface GroupQuickJoinRead {
    readonly command: GroupQuickJoinCommand;
    readonly facts: GroupMutationFacts;
    readonly candidates: readonly GroupQuickJoinCandidate[];
}

export type GroupQuickJoinComputed =
    | Readonly<{
        result: Extract<QuickJoinGroupResult, { status: 'joined'; }>;
        mutation: GroupMutationComputedWrite;
    }>
    | Readonly<{
        result: Extract<QuickJoinGroupResult, { status: 'unavailable'; }>;
        mutation: null;
    }>;
