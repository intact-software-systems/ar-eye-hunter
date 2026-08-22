import type {
    GroupEvent,
    GroupRef,
    GroupScope,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    GroupJoinCodeResponse,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    StateScope,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest
} from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type { PersistedAuthSession } from '../auth/persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';
import type { GroupPolicyCapacityConfig } from '../group-policy.ts';
import type { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import type { GroupStateEventStore } from '../repositories/StateEventStore.ts';
import type { RallarTimingSink } from '../services/timing.ts';
import type { WsSessionGenerationLifecycleService } from '../services/ws-session-generation-lifecycle.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationRead,
    GroupMutationReceipt
} from './mutation/group-mutation-contracts.ts';
import type { GroupSessionCleanupInput } from './presence/group-session-cleanup.ts';

export type GroupWritten = Readonly<{
    snapshot: GroupSnapshot;
    event: GroupEvent;
}>;

export type GroupMutationWritten = Readonly<{
    snapshot: GroupSnapshot;
    event: GroupEvent | null;
}>;

export type GroupStateWritten = Readonly<{
    status: 'created' | 'ok' | 'error';
    result: Either<string, GroupMutationWritten>;
}>;

export type GroupJoinCodeMutationWritten =
    & GroupJoinCodeResponse
    & Readonly<{ event: GroupEvent | null; }>;

export type GroupJoinCodeWritten = Readonly<{
    status: 'ok' | 'error';
    result: Either<string, GroupJoinCodeMutationWritten>;
}>;

export type GroupSnapshotPageOptions = Readonly<{
    afterKey?: string;
    limit: number;
}>;

export type GroupSnapshotPage = Readonly<{
    snapshots: readonly GroupSnapshot[];
    scannedGroupCount: number;
    hasMore: boolean;
    nextGroupKey?: string;
}>;

export type GroupMutationAuthorityProof = Readonly<{
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    commandMac: string;
}>;

export type GroupMutationAuthority = IssuedAuthSession | GroupMutationAuthorityProof;

export const GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

export type GroupMutationDescriptor = Readonly<{
    operation: GroupMutationCommand['operation'];
    scope: StateScope;
    groupId: string;
    targetPrincipalId: string | null;
    sessionId: string | null;
    request:
        | CreateGroupRequest
        | UpdateGroupRequest
        | AppointGroupDirectorRequest
        | JoinGroupRequest
        | CreateGroupInviteRequest
        | RevokeGroupInviteRequest
        | AcceptGroupInviteRequest
        | RotateGroupJoinCodeRequest
        | RemoveGroupMemberRequest
        | BanGroupMemberRequest
        | UnbanGroupMemberRequest
        | SetGroupMemberRoleRequest
        | TransferGroupOwnershipRequest
        | UpsertGroupMemberRequest
        | ConnectGroupPresenceSessionRequest
        | HeartbeatGroupPresenceSessionRequest
        | DisconnectGroupPresenceSessionRequest;
}>;

export type GroupMutationPreparation = Readonly<{
    authorityProof: GroupMutationAuthorityProof | null;
    descriptor: GroupMutationDescriptor | null;
    command: GroupMutationCommand;
    facts: Omit<GroupMutationFacts, 'attemptCount'>;
    causalToken: string;
    queueResourceId: string;
}>;

export type AuthorizedGroupMutation = Readonly<{
    authorityProof: GroupMutationAuthorityProof;
    descriptor: GroupMutationDescriptor;
}>;

export type GroupStateMutationCommand = Readonly<{
    authorityProof: GroupMutationAuthorityProof | null;
    descriptor: GroupMutationDescriptor | null;
    command: GroupMutationCommand;
    facts: GroupMutationFacts;
}>;

export type GroupStateMutationService = Readonly<{
    read(command: GroupStateMutationCommand): Promise<GroupMutationRead>;
    compute(command: GroupStateMutationCommand, read: GroupMutationRead): GroupMutationComputed;
    validate(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed
    ): void;
    write(
        transaction: PSqlTransactionSql,
        computed: GroupMutationComputedWrite
    ): Promise<GroupMutationReceipt>;
}>;

export type GroupStateService =
    & GroupStateMutationService
    & Readonly<{
        sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
        authorizeMutation(
            descriptor: GroupMutationDescriptor,
            authority: IssuedAuthSession
        ): Promise<AuthorizedGroupMutation>;
        prepareMutation(
            descriptor: GroupMutationDescriptor,
            authority: GroupMutationAuthority
        ): Promise<GroupMutationPreparation>;
        prepareAppInboxMutation(
            descriptor: GroupMutationDescriptor,
            authority: GroupMutationAuthority
        ): Promise<GroupMutationPreparation>;
        prepareExpiredPresenceMutations(
            atEpochMs: number
        ): Promise<readonly GroupMutationPreparation[]>;
        prepareSessionCleanupMutations(
            input: GroupSessionCleanupInput
        ): Promise<readonly GroupMutationPreparation[]>;
        prepareFormationCriterionMutation(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationPreparation>;
        listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
        listSnapshotsPage(
            scope: GroupScope,
            options: GroupSnapshotPageOptions
        ): Promise<GroupSnapshotPage>;
        readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
        readStateRevision(ref: GroupRef): Promise<number | undefined>;
        readCausalRevision(ref: GroupRef): Promise<GroupStateCausalRevision | undefined>;
        readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
        listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
        listRecentEvents?(ref: GroupRef, query: StateEventListQuery): Promise<readonly GroupEvent[]>;
        listEventPage(ref: GroupRef, query: StateEventListQuery): Promise<StateEventPage<GroupEvent>>;
        observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
    }>;

export type GroupStateRuntime = Readonly<{
    service: GroupStateService;
}>;

export type GroupStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    formationDamping: 'damped' | 'legacy';
    /**
     * Operational capacity defaults from runtime configuration; absent when the
     * runtime configures none, which keeps stored-cap-only admission.
     */
    capacity?: GroupPolicyCapacityConfig;
    createGroupStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
    ) => GroupStateEventStore;
    now?: () => number;
    randomId?: () => string;
    serviceId: string;
    timing?: RallarTimingSink;
    authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
}>;
