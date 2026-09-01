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
import type {
    GroupAcceptedLayoutRow,
    GroupPlannedLayoutRow
} from './mutation/aggregate/compute-planned-layout-promotion.ts';

import { type AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import type { RallarTimingSink } from '../observability/timing.ts';
import type { GroupStateEventStore } from '../state-events/group-state-event-store.ts';
import type { StateEventListQuery } from '../state-events/state-event-listing.ts';
import type { WsSessionGenerationLifecycleService } from '../websocket/ws-session-generation-lifecycle.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationRead,
    GroupMutationReceipt
} from './mutation/group-mutation-contracts.ts';
import type { GroupSessionCleanupInput } from './presence/group-session-cleanup.ts';

import type {
    GroupConnectAppInboxPayload,
    GroupReconfigureAppInboxPayload
} from './inbox/group-state-inbox-contracts.ts';

export interface GroupWritten {
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent;
}

export interface GroupMutationWritten {
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent | null;
}

export interface GroupStateWritten {
    readonly status: 'created' | 'ok';
    readonly result: GroupMutationWritten;
}

export type GroupJoinCodeMutationWritten =
    & GroupJoinCodeResponse
    & Readonly<{ event: GroupEvent | null; }>;

export interface GroupJoinCodeWritten {
    readonly status: 'ok';
    readonly result: GroupJoinCodeMutationWritten;
}

export interface GroupSnapshotPageOptions {
    readonly afterKey?: string;
    readonly limit: number;
}

export interface GroupSnapshotPage {
    readonly snapshots: readonly GroupSnapshot[];
    readonly scannedGroupCount: number;
    readonly hasMore: boolean;
    readonly nextGroupKey?: string;
}

export interface GroupMutationAuthorityProof {
    readonly version: 1;
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly commandMac: string;
}

export type GroupMutationAuthority = IssuedAuthSession | GroupMutationAuthorityProof;

export const GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

export interface GroupMutationDescriptor {
    readonly operation: GroupMutationCommand['operation'];
    readonly scope: StateScope;
    readonly groupId: string;
    readonly targetPrincipalId: string | null;
    readonly sessionId: string | null;
    readonly request:
        | GroupConnectAppInboxPayload['request']
        | GroupReconfigureAppInboxPayload['request']
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
}

export interface GroupMutationPreparation {
    readonly authorityProof: GroupMutationAuthorityProof | null;
    readonly descriptor: GroupMutationDescriptor | null;
    readonly command: GroupMutationCommand;
    readonly facts: Omit<GroupMutationFacts, 'attemptCount'>;
    readonly causalToken: string;
    readonly queueResourceId: string;
}

export interface AuthorizedGroupMutation {
    readonly authorityProof: GroupMutationAuthorityProof;
    readonly descriptor: GroupMutationDescriptor;
}

export interface GroupStateMutationCommand {
    readonly authorityProof: GroupMutationAuthorityProof | null;
    readonly descriptor: GroupMutationDescriptor | null;
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationFacts;
}

export interface GroupStateMutationService {
    read(command: GroupStateMutationCommand): Promise<GroupMutationRead>;
    compute(command: GroupStateMutationCommand, read: GroupMutationRead): GroupMutationComputed;
    validate(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed
    ): void;
    write(
        transaction: PSqlSql,
        computed: GroupMutationComputedWrite
    ): Promise<GroupMutationReceipt>;
}

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
        prepareFormationAutomationMutation(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationPreparation>;
        prepareTopologyPublicationMutation(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationPreparation>;
        prepareActivationStatusMutation(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationPreparation>;
        listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
        listSnapshotsPage(
            scope: GroupScope,
            options: GroupSnapshotPageOptions
        ): Promise<GroupSnapshotPage>;
        readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
        readCausalRevision(ref: GroupRef): Promise<GroupStateCausalRevision | undefined>;
        readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
        listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
        listRecentEvents(ref: GroupRef, query: StateEventListQuery): Promise<readonly GroupEvent[]>;
        listEventPage(ref: GroupRef, query: StateEventListQuery): Promise<StateEventPage<GroupEvent>>;
        observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
    }>;

export interface GroupStateRuntime {
    readonly service: GroupStateService;
}

export interface GroupStateServiceDependencies {
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    /**
     * Operational capacity defaults from runtime configuration; absent when the
     * runtime configures none, which keeps stored-cap-only admission.
     */
    readonly capacity?: GroupPolicyCapacityConfig;
    readonly groupStateEventStore: GroupStateEventStore;
    readonly now?: () => number;
    readonly randomId?: () => string;
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
    readonly authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
    /**
     * Reads the stored planned-layout row — snapshot, identity, revision and
     * input fingerprint. Null when no planned row exists. Deployments without
     * a topology subsystem supply a constant null reader, which fences every
     * layout-bound command closed as no-planned-layout.
     */
    readonly readPlannedLayoutRow: (ref: GroupRef) => Promise<GroupPlannedLayoutRow | null>;
    /** Reads the accepted slot's identity and revision; null before promotion. */
    readonly readAcceptedLayoutRow: (ref: GroupRef) => Promise<GroupAcceptedLayoutRow | null>;
}
