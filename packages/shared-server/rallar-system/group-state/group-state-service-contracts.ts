import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
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
    GrantGroupPublicationRequest,
    GroupJoinCodeResponse,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    MutationActorInput,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RevokeGroupPublicationRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    StateScope,
    SubscribeGroupTopicRequest,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UnsubscribeGroupTopicRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest
} from '@shared/api/state-types.ts';
import type { ComputedDataValidationIssue } from '../computed-data-validation.ts';
import type {
    GroupAcceptedLayoutRow,
    GroupPlannedLayoutRow
} from './mutation/aggregate/compute-planned-layout-promotion.ts';

import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { RoomOwnedAppData } from '../../app-data/room-owned-app-data.ts';
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
    GroupMutationIngressFacts,
    GroupMutationRead,
    GroupMutationReceipt,
    GroupMutationSnapshotRead
} from './mutation/group-mutation-contracts.ts';
import type { GroupPublicationAuthority } from './persistence/subscription/read-group-topic-subscriptions.ts';
import type { GroupSessionCleanupInput } from './presence/group-session-cleanup.ts';
import type { GroupQuickJoinService } from './quick-join/group-quick-join-service.ts';
import type { GroupRetentionService } from './retention/group-retention-service.ts';

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

interface GroupMutationDescriptorIdentity {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly targetPrincipalId: string | null;
    readonly sessionId: string | null;
}

interface GroupMutationRequests {
    readonly createGroup: CreateGroupRequest;
    readonly updateGroup: UpdateGroupRequest;
    readonly appointDirector: AppointGroupDirectorRequest;
    readonly planGroupLayout: MutationActorInput;
    readonly connectGroup: GroupConnectAppInboxPayload['request'];
    readonly startGroupFormation: MutationActorInput;
    readonly resetGroupFormation: MutationActorInput;
    readonly activateGroup: MutationActorInput;
    readonly reconfigureGroup: GroupReconfigureAppInboxPayload['request'];
    readonly failGroupFormation: MutationActorInput;
    readonly applyPlannedLayout: MutationActorInput;
    readonly updateGroupActivationStatus: MutationActorInput;
    readonly pauseGroupTransport: MutationActorInput;
    readonly resumeGroupTransport: MutationActorInput;
    readonly joinGroup: JoinGroupRequest;
    readonly acceptGroupInvite: AcceptGroupInviteRequest;
    readonly createGroupInvite: CreateGroupInviteRequest;
    readonly revokeGroupInvite: RevokeGroupInviteRequest;
    readonly grantGroupAdmission: MutationActorInput;
    readonly declineGroupAdmission: MutationActorInput;
    readonly removeGroupMember: RemoveGroupMemberRequest;
    readonly banGroupMember: BanGroupMemberRequest;
    readonly unbanGroupMember: UnbanGroupMemberRequest;
    readonly setGroupMemberRole: SetGroupMemberRoleRequest;
    readonly grantGroupPublication: GrantGroupPublicationRequest;
    readonly revokeGroupPublication: RevokeGroupPublicationRequest;
    readonly subscribeGroupTopic: SubscribeGroupTopicRequest;
    readonly unsubscribeGroupTopic: UnsubscribeGroupTopicRequest;
    readonly transferGroupOwnership: TransferGroupOwnershipRequest;
    readonly upsertMember: UpsertGroupMemberRequest;
    readonly rotateGroupJoinCode: RotateGroupJoinCodeRequest;
    readonly connectPresence: ConnectGroupPresenceSessionRequest;
    readonly heartbeatPresence: HeartbeatGroupPresenceSessionRequest;
    readonly disconnectPresence: DisconnectGroupPresenceSessionRequest;
}

/** The operation owns its request shape; command translation preserves that relationship. */
export type GroupMutationDescriptor = {
    [Operation in GroupMutationCommand['operation']]: GroupMutationDescriptorIdentity & {
        readonly operation: Operation;
        readonly request: GroupMutationRequests[Operation];
    };
}[GroupMutationCommand['operation']];

export interface GroupMutationIngress {
    readonly authorityProof: GroupMutationAuthorityProof | null;
    readonly descriptor: GroupMutationDescriptor | null;
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationIngressFacts;
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
    /** The read and the group snapshot a group-result command returns, from one statement on the exact read path. */
    readWithSnapshot(command: GroupStateMutationCommand): Promise<GroupMutationSnapshotRead>;
    compute(command: GroupStateMutationCommand, read: GroupMutationRead): GroupMutationComputed;
    validate(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed
    ): readonly ComputedDataValidationIssue[];
    write(
        transaction: PSqlSql,
        computed: GroupMutationComputedWrite
    ): Promise<GroupMutationReceipt>;
}

export type GroupStateService =
    & GroupStateMutationService
    & Readonly<{
        sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
        quickJoin: GroupQuickJoinService;
        retention: GroupRetentionService;
        authorizeMutation(
            descriptor: GroupMutationDescriptor,
            authority: IssuedAuthSession
        ): Promise<AuthorizedGroupMutation>;
        captureMutationIngress(
            descriptor: GroupMutationDescriptor,
            authority: IssuedAuthSession
        ): Promise<GroupMutationIngress>;
        captureAppInboxMutationIngress(
            descriptor: GroupMutationDescriptor,
            authority: GroupMutationAuthority
        ): Promise<GroupMutationIngress>;
        captureExpiredPresenceMutationIngresses(
            atEpochMs: number
        ): Promise<readonly GroupMutationIngress[]>;
        captureSessionCleanupMutationIngresses(
            input: GroupSessionCleanupInput
        ): Promise<readonly GroupMutationIngress[]>;
        captureFormationCriterionMutationIngress(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationIngress>;
        captureFormationAutomationMutationIngress(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationIngress>;
        captureTopologyPublicationMutationIngress(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationIngress>;
        captureActivationStatusMutationIngress(
            command: GroupMutationCommand,
            atEpochMs: number
        ): Promise<GroupMutationIngress>;
        listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
        listSnapshotsPage(
            scope: GroupScope,
            options: GroupSnapshotPageOptions
        ): Promise<GroupSnapshotPage>;
        readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
        readCausalRevision(ref: GroupRef): Promise<GroupStateCausalRevision | undefined>;
        /** One session's live topic subscription rows, in topicId order; a server-only fact never on the snapshot. */
        readGroupSessionTopicSubscriptions(
            ref: GroupRef,
            sessionId: string
        ): Promise<readonly GroupTopicSubscription[]>;
        /** A granted topic's subscription rows and its candidates' live generations, read fresh after the snapshot. */
        readGroupTopicSubscriptionAuthority(
            snapshot: GroupSnapshot,
            topicId: string
        ): Promise<Omit<GroupPublicationAuthority, 'snapshot'>>;
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
    /** Configured room-owned stores; absent when the application owns no room data. */
    readonly groupOwnedAppData?: Pick<RoomOwnedAppData, 'read'>;
    /**
     * Operational capacity defaults from runtime configuration; absent when the
     * runtime configures none, which keeps stored-cap-only admission.
     */
    readonly capacity?: GroupPolicyCapacityConfig;
    readonly groupStateEventStore: GroupStateEventStore;
    readonly now?: () => number;
    readonly randomId?: () => string;
    readonly serviceId: string;
    /**
     * How long a command's idempotency record and the outbox rows derived from it stay after its ingress; the AppInbox
     * finish gives the command's fact and result the same window.
     */
    readonly finishedRetentionMs: number;
    readonly timing?: RallarTimingSink;
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
