import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
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
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type {
    CanonicalGroupTopologyConfigPatch,
    GroupTopologyConfigPatch,
} from '@shared/api/graph-topology-management-types.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    readCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    GroupMutationDescriptor,
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/services/group-state-service.ts';
import {
    AppInboxEnqueueInput,
    type AppInboxFailure,
    type AppInboxMessageContext,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingSink } from './timing.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    hashAuthSecret,
    type IssuedAuthSession,
    type PersistedAuthSession,
} from '../repositories/AuthSessionRepository.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    createTransactionBoundGroupStateRepository,
    type GroupStateRepository,
} from '../repositories/GroupStateRepository.ts';
import type { GroupMutationComputed, GroupMutationReceipt } from './group-state-mutations.ts';
import { hashCanonicalCommand } from './canonical-command-hash.ts';
import type {
    GroupTopologyManagementService,
    GroupTopologyReconfigureCommand,
} from './group-topology-management-service.ts';
import type { GroupTopologyConfigMutationCommand } from './group-topology-config-mutations.ts';
import { GroupTopologyConfigIdempotencyConflictError } from './group-topology-management-service.ts';
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import { readRttMutation, writeRttMutation } from './rtc-rtt-mutation-service.ts';
import {
    computeRttMutation,
    type RtcRttMutationComputed,
    validateRttMutation,
} from './rtc-topology-mutations.ts';
import { toRtcRttMutationReceiptId } from '../rtc-topology-identifiers.ts';
import type { RtcRttAcceptanceReason } from './rtc-rtt-measurement-policy.ts';
import { validateRtcRttMeasurement } from '../rtc-rtt-persistence-validation.ts';

export {
    type AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

export type GroupCreateAppInboxPayload = Readonly<{
    scope: StateScope;
    request: CreateGroupRequest;
}>;

export type GroupUpdateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: UpdateGroupRequest;
}>;

export type GroupDirectorAppointAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: AppointGroupDirectorRequest;
}>;

export type GroupJoinAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: JoinGroupRequest;
}>;

export type GroupInviteCreateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: CreateGroupInviteRequest;
}>;

export type GroupInviteRevokeAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: RevokeGroupInviteRequest;
}>;

export type GroupInviteAcceptAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: AcceptGroupInviteRequest;
}>;

export type GroupJoinCodeRotateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: RotateGroupJoinCodeRequest;
}>;

export type GroupMemberRemoveAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: RemoveGroupMemberRequest;
}>;

export type GroupMemberBanAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: BanGroupMemberRequest;
}>;

export type GroupMemberUnbanAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: UnbanGroupMemberRequest;
}>;

export type GroupMemberRoleSetAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: SetGroupMemberRoleRequest;
}>;

export type GroupOwnershipTransferAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: TransferGroupOwnershipRequest;
}>;

export type GroupMemberUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: UpsertGroupMemberRequest;
}>;

export type GroupPresenceConnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: ConnectGroupPresenceSessionRequest;
}>;

export type GroupPresenceHeartbeatAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: HeartbeatGroupPresenceSessionRequest;
}>;

export type GroupPresenceDisconnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: DisconnectGroupPresenceSessionRequest;
}>;

export type TopologyAppInboxOperation =
    | 'putConfig'
    | 'deleteConfig'
    | 'putOverride'
    | 'deleteOverride'
    | 'reconfigureTopology'
    | 'submitRtt';

export type TopologyAppInboxRequestPayload =
    | Readonly<{
          operation: 'putConfig';
          config: GroupTopologyConfigPatch;
      }>
    | Readonly<{
          operation: 'deleteConfig';
          target: 'config';
      }>
    | Readonly<{
          operation: 'putOverride';
          config: GroupTopologyConfigPatch;
          ttlMs: number | null;
          expiresAtEpochMs: number | null;
      }>
    | Readonly<{
          operation: 'deleteOverride';
          target: 'override';
      }>
    | Readonly<{
          operation: 'reconfigureTopology';
          requestOptions: GroupTopologyConfigPatch;
          publish: boolean;
      }>;

export type TopologyAppInboxPayload =
    | Readonly<{
          operation: 'putConfig';
          config: CanonicalGroupTopologyConfigPatch;
      }>
    | Readonly<{
          operation: 'deleteConfig';
          target: 'config';
      }>
    | Readonly<{
          operation: 'putOverride';
          config: CanonicalGroupTopologyConfigPatch;
          ttlMs: number | null;
          expiresAtEpochMs: number | null;
      }>
    | Readonly<{
          operation: 'deleteOverride';
          target: 'override';
      }>
    | Readonly<{
          operation: 'reconfigureTopology';
          requestOptions: CanonicalGroupTopologyConfigPatch;
          publish: boolean;
      }>;

export type TopologyAppInboxCommand = Readonly<{
    actor: Readonly<{
        principalId: string;
        sessionId: string;
    }>;
    groupRef: GroupRef;
    requestId: string;
    commandHash: string;
    capturedAtEpochMs: number;
    operation: Exclude<TopologyAppInboxOperation, 'submitRtt'>;
    payload: TopologyAppInboxPayload;
}>;

export type CreateTopologyAppInboxCommandInput = Readonly<{
    actor: TopologyAppInboxCommand['actor'];
    groupRef: GroupRef;
    requestId: string;
    capturedAtEpochMs: number;
    payload: TopologyAppInboxRequestPayload;
}>;

type TopologyMutationAuthorityProof = Readonly<{
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    commandHash: string;
    commandMac: string;
}>;

type TopologyConfigAppInboxAuthority = Readonly<{
    kind: 'topology-config';
    proof: TopologyMutationAuthorityProof;
    command: TopologyAppInboxCommand;
}>;

type TopologyReconfigureAppInboxAuthority = Readonly<{
    kind: 'topology-reconfigure';
    proof: TopologyMutationAuthorityProof;
    command: TopologyAppInboxCommand;
}>;

type TopologyAppInboxAuthority =
    | TopologyConfigAppInboxAuthority
    | TopologyReconfigureAppInboxAuthority;

export type RtcRttAppInboxCommand = Readonly<{
    actor: Readonly<{ principalId: string; sessionId: string }>;
    requestId: string;
    commandHash: string;
    mutationCommandHash: string;
    capturedAtEpochMs: number;
    rtt: RttMeasurementInfo;
}>;

type RtcRttAppInboxAuthority = Readonly<{
    kind: 'rtc-rtt';
    proof: TopologyMutationAuthorityProof;
    command: RtcRttAppInboxCommand;
}>;

export type RtcRttAppInboxDependencies = Readonly<{
    repository: RtcRttRepository;
    readPolicyInputs(command: RtcRttAppInboxCommand): Promise<
        Readonly<{
        candidateGroups: readonly GroupSnapshot[];
        overlaySnapshotsByGroupKey: ReadonlyMap<
            string,
            RallarOverlayTopologySnapshot
        >;
        degreeLimit: number;
        }>
    >;
    observeCommitted?(rtt: RttMeasurementInfo): void;
}>;

export type RtcRttAppInboxResult = Readonly<{
    accepted: boolean;
    reason: RtcRttAcceptanceReason;
    affectedGroups: readonly GroupSnapshot[];
    updated: boolean;
}>;

export async function toTopologyAppInboxCommand(
    input: CreateTopologyAppInboxCommandInput,
): Promise<TopologyAppInboxCommand> {
    if (
        input.requestId.length === 0 ||
        input.actor.principalId.length === 0 ||
        input.actor.sessionId.length === 0 ||
        input.groupRef.applicationId.length === 0 ||
        input.groupRef.workspaceId.length === 0 ||
        input.groupRef.groupId.length === 0 ||
        !isTopologyAppInboxRequestPayload(input.payload) ||
        !Number.isSafeInteger(input.capturedAtEpochMs) ||
        input.capturedAtEpochMs < 0
    ) {
        throw new TypeError('Topology AppInbox command identity is invalid');
    }
    const payload = toCanonicalTopologyAppInboxPayload(input.payload);
    const stableCommand = {
        actor: { ...input.actor },
        groupRef: {
            applicationId: input.groupRef.applicationId,
            workspaceId: input.groupRef.workspaceId,
            groupId: input.groupRef.groupId,
        },
        requestId: input.requestId,
        operation: payload.operation,
        payload,
    } as const;
    return {
        ...stableCommand,
        capturedAtEpochMs: input.capturedAtEpochMs,
        commandHash: await hashCanonicalCommand(stableCommand),
    };
}

export class AppGroupInboxService extends AppInboxService {
    public async processExpiredPresenceSessionsNoWaiting(
        atEpochMs: number,
    ): Promise<number> {
        const preparations = await this.groupStateService.prepareExpiredPresenceMutations(
                atEpochMs,
            );
        for (const preparation of preparations) {
            this.enqueueInternalMutation(
                AppInboxType.GROUP_PRESENCE_EXPIRE,
                preparation,
            );
        }
        return preparations.length;
    }

    public async processDisconnectedPresenceSessionsNoWaiting(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<number> {
        const preparations = await this.groupStateService.prepareSessionCleanupMutations(
                sessionId,
                disconnectedAtEpochMs,
            );
        for (const preparation of preparations) {
            this.enqueueInternalMutation(
                AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
                preparation,
            );
        }
        return preparations.length;
    }

    public override processEntryNoWaiting<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): void {
        void enqueue;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public override processEntryNoWaitingIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ): void {
        void enqueue;
        void enqueueIf;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public override processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        void enqueue;
        return Promise.reject(
            new GroupMutationAuthorizationError(
                'Authenticated group mutation authority is required.',
            ),
        );
    }

    public override processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ): Promise<Either<string, R>> {
        void enqueue;
        void enqueueIf;
        return Promise.reject(
            new GroupMutationAuthorizationError(
                'Authenticated group mutation authority is required.',
            ),
        );
    }

    public async processAuthenticatedEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<string, R>> {
        if (isTopologyConfigInboxType(enqueue.type)) {
            return await this.processAuthenticatedTopologyEntry<V, R>(
                enqueue,
                authority,
            );
        }
        if (!isAuthenticatedGroupMutationInboxType(enqueue.type)) {
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.',
            );
        }
        const preparation = await this.groupStateService.prepareMutation(
            toGroupMutationDescriptor(enqueue),
            authority,
        );
        return await super.processEntryUntilCompletion<V, R>({
            ...enqueue,
            resourceId: preparation.queueResourceId,
            authority: preparation,
        });
    }

    public async processAuthenticatedEntryUntilCompletionResult<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<AppInboxFailure, R>> {
        if (isTopologyConfigInboxType(enqueue.type)) {
            return await this.processAuthenticatedTopologyEntryResult<V, R>(
                enqueue,
                authority,
            );
        }
        if (!isAuthenticatedGroupMutationInboxType(enqueue.type)) {
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.',
            );
        }
        const preparation = await this.groupStateService.prepareMutation(
            toGroupMutationDescriptor(enqueue),
            authority,
        );
        return await super.processEntryUntilCompletionResult<V, R>({
            ...enqueue,
            resourceId: preparation.queueResourceId,
            authority: preparation,
        });
    }

    setTopologyManagementService(
        service: GroupTopologyManagementService,
    ): void {
        if (
            this.topologyManagementService &&
            this.topologyManagementService !== service
        ) {
            throw new TypeError(
                'Topology management service is already configured',
            );
        }
        this.topologyManagementService = service;
    }

    setRtcRttAppInboxDependencies(
        dependencies: RtcRttAppInboxDependencies,
    ): void {
        if (
            this.rtcRttDependencies &&
            this.rtcRttDependencies !== dependencies
        ) {
            throw new TypeError('RTC RTT AppInbox dependencies are already configured');
        }
        this.rtcRttDependencies = dependencies;
    }

    async processRtcRttUntilCompletion(
        input: Readonly<{
        rtt: RttMeasurementInfo;
        alSenderId: string;
        capturedAtEpochMs: number;
        }>,
    ): Promise<Either<string, RtcRttAppInboxResult>> {
        const session = await this.groupStateService.readIssuedAuthSession(
            input.alSenderId,
        );
        if (!session || session.expiresAtEpochMs <= this.nowEpochMs()) {
            throw new GroupMutationAuthorizationError(
                'RTC RTT sender session is missing, expired, or revoked.',
            );
        }
        const requestId = toRtcRttMutationReceiptId(input.rtt);
        const stableRequest = { rtt: input.rtt, alSenderId: input.alSenderId };
        const commandWithoutHash = {
            actor: {
                principalId: session.clientId,
                sessionId: session.sessionId,
            },
            requestId,
            mutationCommandHash: await hashCanonicalCommand(stableRequest),
            capturedAtEpochMs: input.capturedAtEpochMs,
            rtt: input.rtt,
        } as const;
        const stableCommand = {
            actor: commandWithoutHash.actor,
            requestId: commandWithoutHash.requestId,
            mutationCommandHash: commandWithoutHash.mutationCommandHash,
            rtt: commandWithoutHash.rtt,
        } as const;
        const command: RtcRttAppInboxCommand = {
            ...commandWithoutHash,
            commandHash: await hashCanonicalCommand(stableCommand),
        };
        const proof = await createTopologyMutationAuthorityProof(
            session,
            command.commandHash,
        );
        return await super.processEntryUntilCompletion<
            RtcRttAppInboxCommand,
            RtcRttAppInboxResult
        >({
            type: AppInboxType.RTC_RTT_SUBMIT,
            resourceId: requestId,
            data: command,
            authority: {
                kind: 'rtc-rtt',
                proof,
                command,
            } satisfies RtcRttAppInboxAuthority,
        });
    }

    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        database: PSqlSql,
        public readonly groupStateService: GroupStateService,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
        private readonly wakeQueue?: () => void,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            database,
            serviceId,
            SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );

        const processMutation = async (
            _payload: unknown,
            context: AppInboxMessageContext,
        ) => await this.processMutation(context);
        for (const type of GROUP_MUTATION_INBOX_TYPES) {
            this.onStateMessage(type, processMutation);
        }
        const processTopology = async (
            _payload: unknown,
            context: AppInboxMessageContext,
        ) => await this.processTopologyConfigMutation(context);
        for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
            this.onStateMessage(type, processTopology);
        }
        this.onStateMessage(
            AppInboxType.RTC_RTT_SUBMIT,
            async (_payload, context) => await this.processRtcRttMutation(context),
        );
    }

    private topologyManagementService?: GroupTopologyManagementService;
    private rtcRttDependencies?: RtcRttAppInboxDependencies;

    private async processAuthenticatedTopologyEntry<V, R>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<string, R>> {
        return await super.processEntryUntilCompletion<V, R>(
            await this.toAuthenticatedTopologyEnqueue(enqueue, authority),
        );
    }

    private async processAuthenticatedTopologyEntryResult<V, R>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<AppInboxFailure, R>> {
        return await super.processEntryUntilCompletionResult<V, R>(
            await this.toAuthenticatedTopologyEnqueue(enqueue, authority),
        );
    }

    private async toAuthenticatedTopologyEnqueue<V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<AppInboxEnqueueInput<V>> {
        const command = await readAuthenticatedTopologyCommand(enqueue, authority);
        const currentSession = await this.requireCurrentTopologySession(command, authority);
        const proof = await createTopologyMutationAuthorityProof(
            currentSession,
            command.commandHash,
        );
        const durableAuthority: TopologyAppInboxAuthority =
            command.operation === 'reconfigureTopology'
                ? { kind: 'topology-reconfigure', proof, command }
                : { kind: 'topology-config', proof, command };
        return { ...enqueue, authority: durableAuthority };
    }

    private async processTopologyConfigMutation(
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        const authority = readTopologyConfigAuthority(
            context.enqueue.authority,
        );
        await this.verifyTopologyMutationAuthority(authority);
        if (authority.kind === 'topology-reconfigure') {
            return await this.processTopologyReconfigureMutation(
                context,
                authority,
            );
        }
        const service = this.requireTopologyManagementService();
        const preparation = await service.prepareTopologyConfigMutation({
            command: toTopologyConfigMutationCommand(authority.command),
            commandHash: authority.command.commandHash,
            capturedAtEpochMs: authority.command.capturedAtEpochMs,
        });
        const read = await service.readTopologyConfigMutation(
            preparation.command,
        );
        const attemptCount = context.entry.dequeueAudit.attempts;
        const computed = service.computeTopologyConfigMutation(
            preparation,
            read,
            attemptCount,
        );
        service.validateTopologyConfigMutation(
            preparation,
            read,
            attemptCount,
            computed,
        );
        if (computed.outcome === 'idempotency-conflict') {
            throw new GroupTopologyConfigIdempotencyConflictError(
                computed.existingCommandHash,
                computed.receivedCommandHash,
            );
        }
        const result = await this.writeMutation(
            context,
            async (transaction) => {
                if (
                    computed.outcome === 'write' ||
                    computed.outcome === 'claim'
                ) {
                    await service.writeTopologyConfigMutation(
                        transaction,
                        computed,
                    );
                }
                return service.toTopologyConfigMutationResult(computed);
            },
        );
        if (computed.outcome === 'write') this.wakeQueue?.();
        return result;
    }

    private async processTopologyReconfigureMutation(
        context: AppInboxMessageContext,
        authority: TopologyReconfigureAppInboxAuthority,
    ): Promise<unknown> {
        const service = this.requireTopologyManagementService();
        if (authority.command.payload.operation !== 'reconfigureTopology') {
            throw new TypeError('Topology reconfigure authority operation is invalid');
        }
        const command: GroupTopologyReconfigureCommand = {
            groupRef: authority.command.groupRef,
            commandId: authority.command.requestId,
            actorPrincipalId: authority.command.actor.principalId,
            capturedAtEpochMs: authority.command.capturedAtEpochMs,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(
                authority.command.payload.requestOptions,
            ),
            publish: authority.command.payload.publish,
            isPlatformAdmin: service.isPlatformAdmin(
                authority.command.actor.principalId,
            ),
        };
        const read = await service.readTopologyMutation(command);
        const computed = service.computeTopologyMutation(command, read);
        service.validateTopologyMutation(command, read, computed);
        const result = await this.writeMutation(context, async (transaction) => {
            await service.writeTopologyMutation(transaction, computed);
            return {
                status: 'queued',
                groupRef: command.groupRef,
                requestId: command.commandId,
                outboxId: computed.resourceId,
            };
        });
        this.wakeQueue?.();
        return result;
    }

    private async processRtcRttMutation(
        context: AppInboxMessageContext,
    ): Promise<RtcRttAppInboxResult> {
        const authority = readRtcRttAuthority(context.enqueue.authority);
        await this.verifyRtcRttAuthority(authority);
        const dependencies = this.requireRtcRttDependencies();
        const stableRequest = {
            rtt: authority.command.rtt,
            alSenderId: authority.command.actor.sessionId,
        };
        const read = await readRttMutation(
            dependencies.repository,
            stableRequest,
        );
        const attemptCount = context.entry.dequeueAudit.attempts;
        const command = read.receipt
            ? {
                ...stableRequest,
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null,
            } as const
            : {
                ...stableRequest,
                ...await dependencies.readPolicyInputs(authority.command),
            };
        const lifecycleFacts = read.receipt
            ? {
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
            } as const
            : await dependencies.repository.readMutationFacts();
        const facts = {
            ...lifecycleFacts,
            commandHash: authority.command.mutationCommandHash,
            attemptCount,
        };
        const computed = computeRttMutation({ command, read, facts });
        validateRttMutation({ command, read, facts, computed });
        const result = await this.writeMutation(context, async (transaction) => {
            if (computed.outcome === 'write') {
                if (
                    facts.requestedAtEpochMs === null ||
                    facts.purgeAfterEpochMs === null
                ) {
                    throw new TypeError('RTC RTT write lifecycle facts are missing');
                }
                await writeRttMutation(
                    transaction,
                    {
                        ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
                        now: () => facts.requestedAtEpochMs,
                    },
                    computed,
                );
            }
            return toRtcRttAppInboxResult(computed);
        });
        if (computed.outcome === 'write') {
            dependencies.observeCommitted?.(computed.measurementGuard.value);
            this.wakeQueue?.();
        }
        return result;
    }

    private async verifyRtcRttAuthority(
        authority: RtcRttAppInboxAuthority,
    ): Promise<void> {
        const session = await this.groupStateService.readIssuedAuthSession(
            authority.proof.sessionId,
        );
        if (
            !session ||
            session.clientId !== authority.command.actor.principalId ||
            session.sessionId !== authority.command.actor.sessionId ||
            session.expiresAtEpochMs <= this.nowEpochMs() ||
            authority.command.commandHash !== authority.proof.commandHash
        ) {
            throw new GroupMutationAuthorizationError(
                'RTC RTT authority is missing, expired, revoked, or mismatched.',
            );
        }
        const expected = await createTopologyMutationAuthorityProof(
            session,
            authority.command.commandHash,
        );
        if (!constantTimeEqual(expected.commandMac, authority.proof.commandMac)) {
            throw new GroupMutationAuthorizationError(
                'RTC RTT authority proof does not match the command.',
            );
        }
        const canonicalStableCommand = {
            actor: authority.command.actor,
            requestId: authority.command.requestId,
            mutationCommandHash: authority.command.mutationCommandHash,
            rtt: authority.command.rtt,
        };
        if (
            await hashCanonicalCommand(canonicalStableCommand) !==
                authority.command.commandHash ||
            await hashCanonicalCommand({
                rtt: authority.command.rtt,
                alSenderId: authority.command.actor.sessionId,
            }) !== authority.command.mutationCommandHash
        ) {
            throw new GroupMutationAuthorizationError(
                'RTC RTT durable command hash is invalid.',
            );
        }
    }

    private requireRtcRttDependencies(): RtcRttAppInboxDependencies {
        if (!this.rtcRttDependencies) {
            throw new TypeError('RTC RTT AppInbox dependencies are not configured');
        }
        return this.rtcRttDependencies;
    }

    private async requireCurrentTopologySession(
        command: TopologyAppInboxCommand,
        claimed: IssuedAuthSession,
    ): Promise<PersistedAuthSession> {
        const session = await this.groupStateService.readIssuedAuthSession(
            command.actor.sessionId,
        );
        if (
            !session ||
            session.clientId !== command.actor.principalId ||
            session.sessionId !== command.actor.sessionId ||
            session.clientId !== claimed.clientId ||
            session.sessionId !== claimed.sessionId ||
            session.issuedAtEpochMs !== claimed.issuedAtEpochMs ||
            session.expiresAtEpochMs !== claimed.expiresAtEpochMs ||
            session.accessTokenDigest !== await hashAuthSecret(claimed.accessToken) ||
            session.expiresAtEpochMs <= this.nowEpochMs()
        ) {
            throw new GroupMutationAuthorizationError(
                'Topology mutation session is missing, expired, revoked, or mismatched.',
            );
        }
        return session;
    }

    private async verifyTopologyMutationAuthority(
        authority: TopologyAppInboxAuthority,
    ): Promise<void> {
        const actorPrincipalId = authority.command.actor.principalId;
        const commandHash = authority.command.commandHash;
        const session = await this.groupStateService.readIssuedAuthSession(
            authority.proof.sessionId,
        );
        if (
            !session ||
            session.clientId !== authority.proof.principalId ||
            session.sessionId !== authority.proof.sessionId ||
            session.issuedAtEpochMs !==
                authority.proof.sessionIssuedAtEpochMs ||
            session.expiresAtEpochMs !==
                authority.proof.sessionExpiresAtEpochMs ||
            session.expiresAtEpochMs <= this.nowEpochMs() ||
            actorPrincipalId !== authority.proof.principalId ||
            commandHash !== authority.proof.commandHash
        ) {
            throw new GroupMutationAuthorizationError(
                'Topology mutation authority is missing, expired, revoked, or mismatched.',
            );
        }
        const expected = await createTopologyMutationAuthorityProof(
            session,
            authority.proof.commandHash,
        );
        if (
            !constantTimeEqual(expected.commandMac, authority.proof.commandMac)
        ) {
            throw new GroupMutationAuthorizationError(
                'Topology mutation authority proof does not match the command.',
            );
        }
        const command = authority.command;
        if (
            await hashCanonicalCommand({
                actor: command.actor,
                groupRef: command.groupRef,
                requestId: command.requestId,
                operation: command.operation,
                payload: command.payload,
            }) !== command.commandHash
        ) {
            throw new GroupMutationAuthorizationError(
                'Topology durable command hash is invalid.',
            );
        }
    }

    private requireTopologyManagementService(): GroupTopologyManagementService {
        if (!this.topologyManagementService) {
            throw new TypeError(
                'Topology management service is not configured',
            );
        }
        return this.topologyManagementService;
    }

    private enqueueInternalMutation(
        type:
            | AppInboxType.GROUP_PRESENCE_EXPIRE
            | AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        preparation: GroupMutationPreparation,
    ): void {
        super.processEntryNoWaiting({
            type,
            resourceId: preparation.queueResourceId,
            authority: preparation,
            data: { commandId: preparation.command.commandId },
        });
    }

    private async processMutation(
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        const prepared = readGroupMutationPreparation(
            context.enqueue.authority,
        );
        const command: GroupStateMutationCommand = {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: {
                ...prepared.facts,
                attemptCount: context.entry.dequeueAudit.attempts,
            },
        };
        const read = await this.groupStateService.read(command);
        const computed = this.groupStateService.compute(command, read);
        this.groupStateService.validate(command, read, computed);
        return await this.commitMutation(context, command, computed);
    }

    private async commitMutation(
        context: AppInboxMessageContext,
        command: GroupStateMutationCommand,
        computed: GroupMutationComputed,
    ): Promise<unknown> {
        const result = await this.writeMutation(
            context,
            async (transaction) => {
                if (computed.outcome === 'idempotency-conflict') {
                    throw new TypeError(
                        'Validated group idempotency conflict is unreachable',
                    );
                }
                const receipt = computed.receipt;
                if (computed.outcome === 'write') {
                    await this.groupStateService.write(transaction, computed);
                }
                if (isPresenceOperation(command.command.operation)) {
                    return receipt;
                }
                const repository = createTransactionBoundGroupStateRepository(transaction);
                const snapshot = await repository.readSnapshot(
                    command.command.aggregateRef,
                );
                if (!snapshot) {
                    throw new TypeError(
                        `Group snapshot not found after ${command.command.operation}`,
                    );
                }
                const event = await readReceiptEvent(
                    repository,
                    command.command.aggregateRef,
                    receipt,
                );
                if (command.command.operation === 'rotateGroupJoinCode') {
                    if (receipt.outcome === 'rejected') {
                        return {
                            status: 'error',
                            result: Either.ofLeft(
                                receipt.rejection ??
                                    'Join-code rotation rejected',
                            ),
                        };
                    }
                    if (
                        receipt.joinCode === null ||
                        receipt.joinCodeExpiresAtEpochMs === null
                    ) {
                        throw new TypeError(
                            'Join-code mutation result is incomplete',
                        );
                    }
                    return {
                        status: 'ok',
                        result: Either.ofRight({
                            joinCode: receipt.joinCode,
                            expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
                            snapshot,
                            event,
                        }),
                    };
                }
                if (receipt.outcome === 'rejected') {
                    return {
                        status: 'error',
                        result: Either.ofLeft(
                            receipt.rejection ?? 'Group mutation rejected',
                        ),
                    };
                }
                return {
                    status: command.command.operation === 'createGroup' ? 'created' : 'ok',
                    result: Either.ofRight({ snapshot, event }),
                };
            },
        );
        this.wakeQueue?.();
        return result;
    }
}

function isPresenceOperation(
    operation: GroupStateMutationCommand['command']['operation'],
): boolean {
    return (
        operation === 'connectPresence' ||
        operation === 'heartbeatPresence' ||
        operation === 'disconnectPresence'
    );
}

async function readReceiptEvent(
    repository: GroupStateRepository,
    ref: GroupRef,
    receipt: GroupMutationReceipt,
): Promise<GroupEvent | null> {
    if (receipt.eventId === null) return null;
    const event = (await repository.listEvents(ref)).find(
        (candidate) => candidate.eventId === receipt.eventId,
    );
    if (!event) {
        throw new TypeError(
            `Group mutation event not found: ${receipt.eventId}`,
        );
    }
    return event;
}

function readGroupMutationPreparation(
    value: unknown,
): GroupMutationPreparation {
    const expectedKeys = [
        'authorityProof',
        'descriptor',
        'command',
        'facts',
        'causalToken',
        'queueResourceId',
    ].toSorted();
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).toSorted()) !==
            JSON.stringify(expectedKeys) ||
        !('authorityProof' in value) ||
        !isAuthorityProofOrNull(value.authorityProof) ||
        !('descriptor' in value) ||
        !isRecordOrNull(value.descriptor) ||
        !('command' in value) ||
        !value.command ||
        typeof value.command !== 'object' ||
        !('facts' in value) ||
        !value.facts ||
        typeof value.facts !== 'object' ||
        !('causalToken' in value) ||
        typeof value.causalToken !== 'string' ||
        !('queueResourceId' in value) ||
        typeof value.queueResourceId !== 'string'
    ) {
        throw new GroupMutationAuthorizationError(
            'App inbox durable group mutation facts are malformed.',
        );
    }
    return value as GroupMutationPreparation;
}

export const AUTHENTICATED_GROUP_INBOX_TYPES = [
    AppInboxType.GROUP_CREATE,
    AppInboxType.GROUP_UPDATE,
    AppInboxType.GROUP_DIRECTOR_APPOINT,
    AppInboxType.GROUP_JOIN,
    AppInboxType.GROUP_INVITE_CREATE,
    AppInboxType.GROUP_INVITE_REVOKE,
    AppInboxType.GROUP_INVITE_ACCEPT,
    AppInboxType.GROUP_JOIN_CODE_ROTATE,
    AppInboxType.GROUP_MEMBER_REMOVE,
    AppInboxType.GROUP_MEMBER_BAN,
    AppInboxType.GROUP_MEMBER_UNBAN,
    AppInboxType.GROUP_MEMBER_ROLE_SET,
    AppInboxType.GROUP_OWNERSHIP_TRANSFER,
    AppInboxType.GROUP_MEMBER_UPSERT,
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT,
] as const;

const GROUP_MUTATION_INBOX_TYPES = [
    ...AUTHENTICATED_GROUP_INBOX_TYPES,
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
] as const;

const TOPOLOGY_CONFIG_INBOX_TYPES = [
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
] as const;

function isAuthorityProofOrNull(value: unknown): boolean {
    return (
        value === null ||
        (typeof value === 'object' &&
        !Array.isArray(value) &&
        value !== null &&
        'version' in value &&
            value.version === 1)
    );
}

function isRecordOrNull(value: unknown): boolean {
    return (
        value === null ||
        (typeof value === 'object' && !Array.isArray(value) && value !== null)
    );
}

function isAuthenticatedGroupMutationInboxType(type: AppInboxType): boolean {
    return (
        AUTHENTICATED_GROUP_INBOX_TYPES as readonly AppInboxType[]
    ).includes(type);
}

function isTopologyConfigInboxType(type: AppInboxType): boolean {
    return (TOPOLOGY_CONFIG_INBOX_TYPES as readonly AppInboxType[]).includes(
        type,
    );
}

async function readAuthenticatedTopologyCommand<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
): Promise<TopologyAppInboxCommand> {
    const command = enqueue.data as TopologyAppInboxCommand;
    if (
        !command ||
        typeof command !== 'object' ||
        !command.actor ||
        typeof command.actor !== 'object' ||
        typeof command.actor.principalId !== 'string' ||
        typeof command.actor.sessionId !== 'string' ||
        !command.groupRef ||
        typeof command.groupRef !== 'object' ||
        typeof command.operation !== 'string' ||
        !isTopologyAppInboxPayload(command.payload) ||
        command.payload.operation !== command.operation ||
        command.actor.principalId !== authority.clientId ||
        command.actor.sessionId !== authority.sessionId ||
        topologyInboxTypeForOperation(command.operation) !== enqueue.type
    ) {
        throw new GroupMutationAuthorizationError(
            'Topology AppInbox command does not match authenticated authority.',
        );
    }
    const stableCommand = {
        actor: command.actor,
        groupRef: command.groupRef,
        requestId: command.requestId,
        operation: command.operation,
        payload: command.payload,
    };
    if (await hashCanonicalCommand(stableCommand) !== command.commandHash) {
        throw new GroupMutationAuthorizationError(
            'Topology AppInbox command hash is invalid.',
        );
    }
    return command;
}

function isTopologyAppInboxRequestPayload(
    value: unknown,
): value is TopologyAppInboxRequestPayload {
    if (!isRecord(value) || typeof value.operation !== 'string') return false;
    try {
        switch (value.operation) {
            case 'putConfig':
                requireExactKeys(value, ['operation', 'config']);
                toCanonicalGroupTopologyConfigPatch(value.config);
                return true;
            case 'deleteConfig':
                requireExactKeys(value, ['operation', 'target']);
                return value.target === 'config';
            case 'putOverride':
                requireExactKeys(value, [
                    'operation',
                    'config',
                    'ttlMs',
                    'expiresAtEpochMs',
                ]);
                toCanonicalGroupTopologyConfigPatch(value.config);
                return isFiniteNumberOrNull(value.ttlMs) &&
                    isFiniteNumberOrNull(value.expiresAtEpochMs);
            case 'deleteOverride':
                requireExactKeys(value, ['operation', 'target']);
                return value.target === 'override';
            case 'reconfigureTopology':
                requireExactKeys(value, [
                    'operation',
                    'requestOptions',
                    'publish',
                ]);
                toCanonicalGroupTopologyConfigPatch(value.requestOptions);
                return typeof value.publish === 'boolean';
            default:
                return false;
        }
    } catch {
        return false;
    }
}

function isTopologyAppInboxPayload(
    value: unknown,
): value is TopologyAppInboxPayload {
    if (!isRecord(value)) return false;
    const record = value;
    if (typeof record.operation !== 'string') {
        return false;
    }
    try {
        switch (record.operation) {
            case 'putConfig':
                requireExactKeys(record, ['operation', 'config']);
                readCanonicalGroupTopologyConfigPatch(record.config);
                return true;
            case 'deleteConfig':
                requireExactKeys(record, ['operation', 'target']);
                return record.target === 'config';
            case 'putOverride':
                requireExactKeys(record, [
                    'operation',
                    'config',
                    'ttlMs',
                    'expiresAtEpochMs',
                ]);
                readCanonicalGroupTopologyConfigPatch(record.config);
                return isFiniteNumberOrNull(record.ttlMs) &&
                    isFiniteNumberOrNull(record.expiresAtEpochMs);
            case 'deleteOverride':
                requireExactKeys(record, ['operation', 'target']);
                return record.target === 'override';
            case 'reconfigureTopology':
                requireExactKeys(record, [
                    'operation',
                    'requestOptions',
                    'publish',
                ]);
                readCanonicalGroupTopologyConfigPatch(record.requestOptions);
                return typeof record.publish === 'boolean';
            default:
                return false;
        }
    } catch {
        return false;
    }
}

function toCanonicalTopologyAppInboxPayload(
    payload: TopologyAppInboxRequestPayload,
): TopologyAppInboxPayload {
    switch (payload.operation) {
        case 'putConfig':
            return {
                operation: payload.operation,
                config: toCanonicalGroupTopologyConfigPatch(payload.config),
            };
        case 'deleteConfig':
        case 'deleteOverride':
            return { ...payload };
        case 'putOverride':
            return {
                ...payload,
                config: toCanonicalGroupTopologyConfigPatch(payload.config),
            };
        case 'reconfigureTopology':
            return {
                ...payload,
                requestOptions: toCanonicalGroupTopologyConfigPatch(
                    payload.requestOptions,
                ),
            };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(
    record: Record<string, unknown>,
    expected: readonly string[],
): void {
    if (
        JSON.stringify(Object.keys(record).toSorted()) !==
            JSON.stringify([...expected].toSorted())
    ) {
        throw new TypeError('Topology durable command has missing or unknown fields');
    }
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
    return value === null ||
        (typeof value === 'number' && Number.isFinite(value));
}

function topologyInboxTypeForOperation(
    operation: TopologyAppInboxCommand['operation'],
): AppInboxType {
    switch (operation) {
        case 'putConfig':
            return AppInboxType.TOPOLOGY_CONFIG_PUT;
        case 'deleteConfig':
            return AppInboxType.TOPOLOGY_CONFIG_DELETE;
        case 'putOverride':
            return AppInboxType.TOPOLOGY_OVERRIDE_PUT;
        case 'deleteOverride':
            return AppInboxType.TOPOLOGY_OVERRIDE_DELETE;
        case 'reconfigureTopology':
            return AppInboxType.TOPOLOGY_RECONFIGURE;
    }
}

function toTopologyConfigMutationCommand(
    command: TopologyAppInboxCommand,
): GroupTopologyConfigMutationCommand {
    switch (command.payload.operation) {
        case 'putConfig':
            return topologyConfigMutationCommand(
                command,
                fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                null,
                null,
            );
        case 'deleteConfig':
            return topologyConfigMutationCommand(command, null, null, null);
        case 'putOverride':
            return topologyConfigMutationCommand(
                command,
                fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                command.payload.ttlMs,
                command.payload.expiresAtEpochMs,
            );
        case 'deleteOverride':
            return topologyConfigMutationCommand(command, null, null, null);
        case 'reconfigureTopology':
            throw new TypeError(
                'Reconfigure is not a topology config mutation',
            );
    }
}

function topologyConfigMutationCommand(
    command: TopologyAppInboxCommand,
    config: GroupTopologyConfigPatch | null,
    ttlMs: number | null,
    expiresAtEpochMs: number | null,
): GroupTopologyConfigMutationCommand {
    if (command.operation === 'reconfigureTopology') {
        throw new TypeError('Reconfigure is not a topology config mutation');
    }
    return {
        operation: command.operation,
        aggregateRef: command.groupRef,
        commandId: command.requestId,
        requestId: command.requestId,
        input: {
            config,
            updatedByPrincipalId: command.actor.principalId,
            ttlMs,
            expiresAtEpochMs,
        },
    };
}

function readTopologyConfigAuthority(
    value: unknown,
): TopologyAppInboxAuthority {
    try {
        if (!isRecord(value)) throw new TypeError('authority is not a record');
        requireExactKeys(value, ['kind', 'proof', 'command']);
        if (
            value.kind !== 'topology-config' &&
            value.kind !== 'topology-reconfigure'
        ) {
            throw new TypeError('authority kind is invalid');
        }
        readTopologyMutationAuthorityProof(value.proof);
        readDurableTopologyAppInboxCommand(value.command);
        return value as TopologyAppInboxAuthority;
    } catch {
        throw new GroupMutationAuthorizationError(
            'Topology AppInbox durable authority is malformed.',
        );
    }
}

function readRtcRttAuthority(value: unknown): RtcRttAppInboxAuthority {
    try {
        if (!isRecord(value)) throw new TypeError('authority is not a record');
        requireExactKeys(value, ['kind', 'proof', 'command']);
        if (value.kind !== 'rtc-rtt') throw new TypeError('authority kind is invalid');
        readTopologyMutationAuthorityProof(value.proof);
        const command = isRecord(value.command) ? value.command : null;
        if (!command) throw new TypeError('RTC RTT command is invalid');
        requireExactKeys(command, [
            'actor',
            'requestId',
            'commandHash',
            'mutationCommandHash',
            'capturedAtEpochMs',
            'rtt',
        ]);
        validateRtcRttMeasurement(command.rtt);
        return value as RtcRttAppInboxAuthority;
    } catch {
        throw new GroupMutationAuthorizationError(
            'RTC RTT AppInbox durable authority is malformed.',
        );
    }
}

function readTopologyMutationAuthorityProof(value: unknown): void {
    if (!isRecord(value)) throw new TypeError('authority proof is invalid');
    requireExactKeys(value, [
        'version',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'commandHash',
        'commandMac',
    ]);
    if (
        value.version !== 1 ||
        typeof value.principalId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !Number.isSafeInteger(value.sessionIssuedAtEpochMs) ||
        !Number.isSafeInteger(value.sessionExpiresAtEpochMs) ||
        typeof value.commandHash !== 'string' ||
        typeof value.commandMac !== 'string'
    ) {
        throw new TypeError('authority proof fields are invalid');
    }
}

function readDurableTopologyAppInboxCommand(
    value: unknown,
): TopologyAppInboxCommand {
    if (!isRecord(value)) throw new TypeError('topology command is invalid');
    requireExactKeys(value, [
        'actor',
        'groupRef',
        'requestId',
        'commandHash',
        'capturedAtEpochMs',
        'operation',
        'payload',
    ]);
    if (!isTopologyAppInboxPayload(value.payload)) {
        throw new TypeError('topology command payload is invalid');
    }
    const actor = isRecord(value.actor) ? value.actor : null;
    const groupRef = isRecord(value.groupRef) ? value.groupRef : null;
    if (!actor || !groupRef) throw new TypeError('topology identity is invalid');
    requireExactKeys(actor, ['principalId', 'sessionId']);
    requireExactKeys(groupRef, ['applicationId', 'workspaceId', 'groupId']);
    if (
        typeof actor.principalId !== 'string' ||
        actor.principalId.length === 0 ||
        typeof actor.sessionId !== 'string' ||
        actor.sessionId.length === 0 ||
        typeof groupRef.applicationId !== 'string' ||
        groupRef.applicationId.length === 0 ||
        typeof groupRef.workspaceId !== 'string' ||
        groupRef.workspaceId.length === 0 ||
        typeof groupRef.groupId !== 'string' ||
        groupRef.groupId.length === 0 ||
        typeof value.requestId !== 'string' ||
        value.requestId.length === 0 ||
        typeof value.commandHash !== 'string' ||
        !Number.isSafeInteger(value.capturedAtEpochMs) ||
        (value.capturedAtEpochMs as number) < 0 ||
        value.operation !== value.payload.operation
    ) {
        throw new TypeError('topology command identity fields are invalid');
    }
    return value as TopologyAppInboxCommand;
}

function toRtcRttAppInboxResult(
    computed: RtcRttMutationComputed,
): RtcRttAppInboxResult {
    if (computed.outcome === 'replay') {
        return {
            accepted: true,
            reason: 'accepted',
            affectedGroups: [],
            updated: false,
        };
    }
    if (computed.outcome === 'rejected') {
        return computed.reason === 'stale'
            ? {
                accepted: true,
                reason: 'accepted',
                affectedGroups: [],
                updated: false,
            }
            : {
                accepted: false,
                reason: computed.reason,
                affectedGroups: computed.affectedGroups,
                updated: false,
            };
    }
    return {
        accepted: true,
        reason: computed.reason,
        affectedGroups: computed.affectedGroups,
        updated: true,
    };
}

async function createTopologyMutationAuthorityProof(
    session: IssuedAuthSession | PersistedAuthSession,
    commandHash: string,
): Promise<TopologyMutationAuthorityProof> {
    const proof = {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandHash,
    } as const;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(
            'accessTokenDigest' in session
                ? session.accessTokenDigest
                : await hashAuthSecret(session.accessToken),
        ),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const bytes = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(
            JSON.stringify({
                purpose: 'rallar-topology-mutation-authority',
                ...proof,
            }),
        ),
    );
    return {
        ...proof,
        commandMac: [...new Uint8Array(bytes)]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join(''),
    };
}

function constantTimeEqual(left: string, right: string): boolean {
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

function toGroupMutationDescriptor<V>(
    enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
    switch (enqueue.type) {
        case AppInboxType.GROUP_CREATE: {
            const payload = enqueue.data as GroupCreateAppInboxPayload;
            return descriptor(
                'createGroup',
                payload.scope,
                payload.request.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_UPDATE: {
            const payload = enqueue.data as GroupUpdateAppInboxPayload;
            return descriptor(
                'updateGroup',
                payload.scope,
                payload.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_DIRECTOR_APPOINT: {
            const payload = enqueue.data as GroupDirectorAppointAppInboxPayload;
            return descriptor(
                'appointDirector',
                payload.scope,
                payload.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_JOIN: {
            const payload = enqueue.data as GroupJoinAppInboxPayload;
            return descriptor(
                'joinGroup',
                payload.scope,
                payload.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_INVITE_CREATE: {
            const payload = enqueue.data as GroupInviteCreateAppInboxPayload;
            return descriptor(
                'createGroupInvite',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_INVITE_REVOKE: {
            const payload = enqueue.data as GroupInviteRevokeAppInboxPayload;
            return descriptor(
                'revokeGroupInvite',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_INVITE_ACCEPT: {
            const payload = enqueue.data as GroupInviteAcceptAppInboxPayload;
            return descriptor(
                'acceptGroupInvite',
                payload.scope,
                payload.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_JOIN_CODE_ROTATE: {
            const payload = enqueue.data as GroupJoinCodeRotateAppInboxPayload;
            return descriptor(
                'rotateGroupJoinCode',
                payload.scope,
                payload.groupId,
                payload.request,
            );
        }
        case AppInboxType.GROUP_MEMBER_REMOVE:
        case AppInboxType.GROUP_MEMBER_BAN:
        case AppInboxType.GROUP_MEMBER_UNBAN: {
            const payload = enqueue.data as GroupMemberRemoveAppInboxPayload;
            const operation = enqueue.type === AppInboxType.GROUP_MEMBER_REMOVE
                ? 'removeGroupMember'
                : enqueue.type === AppInboxType.GROUP_MEMBER_BAN
                ? 'banGroupMember'
                : 'unbanGroupMember';
            return descriptor(
                operation,
                payload.scope,
                payload.groupId,
                payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_MEMBER_ROLE_SET: {
            const payload = enqueue.data as GroupMemberRoleSetAppInboxPayload;
            return descriptor(
                'setGroupMemberRole',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER: {
            const payload = enqueue.data as GroupOwnershipTransferAppInboxPayload;
            return descriptor(
                'transferGroupOwnership',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.request.newOwnerPrincipalId,
            );
        }
        case AppInboxType.GROUP_MEMBER_UPSERT: {
            const payload = enqueue.data as GroupMemberUpsertAppInboxPayload;
            return descriptor(
                'upsertMember',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_CONNECT: {
            const payload = enqueue.data as GroupPresenceConnectAppInboxPayload;
            return descriptor(
                'connectPresence',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.request.principalId,
                payload.sessionId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT: {
            const payload = enqueue.data as GroupPresenceHeartbeatAppInboxPayload;
            return descriptor(
                'heartbeatPresence',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.request.principalId ?? null,
                payload.sessionId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_DISCONNECT: {
            const payload = enqueue.data as GroupPresenceDisconnectAppInboxPayload;
            return descriptor(
                'disconnectPresence',
                payload.scope,
                payload.groupId,
                payload.request,
                payload.request.principalId ?? null,
                payload.sessionId,
            );
        }
        default:
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.',
            );
    }
}

function descriptor(
    operation: GroupMutationDescriptor['operation'],
    scope: StateScope,
    groupId: string,
    request: GroupMutationDescriptor['request'],
    targetPrincipalId: string | null = null,
    sessionId: string | null = null,
): GroupMutationDescriptor {
    return { operation, scope, groupId, targetPrincipalId, sessionId, request };
}
