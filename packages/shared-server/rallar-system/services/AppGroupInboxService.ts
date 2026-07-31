import type { GroupRef } from '@shared/api/group-types.ts';
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
import type { IssuedAuthSession } from '../repositories/auth-session-types.ts';
import type { PersistedAuthSession } from '../repositories/auth-persistence-contracts.ts';
import { authSessionProofSecret } from './auth-session-proof-secret.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
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
    validateRttMutation,
} from './rtc-topology-mutations.ts';
import { toRtcRttMutationReceiptId } from '../rtc-topology-identifiers.ts';
import {
    type RtcRttAppInboxResult,
    toRtcRttAppInboxResult,
} from './rtc-rtt-app-inbox-result.ts';
export type { RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';
import { validateRtcRttMeasurement } from '../rtc-rtt-persistence-validation.ts';
import {
    processGroupSessionCleanup,
    requireTopologyManagementService,
    toExpiredPresenceEnqueue,
    toGroupSessionCleanupEnqueue,
    type GroupPresenceSessionCleanupAppInboxPayload,
} from './app-group-ws-session-lifecycle.ts';
import { GroupStateInboxHandler } from '../group-state/inbox/group-state-inbox-handler.ts';
import {
    AUTHENTICATED_GROUP_INBOX_TYPES,
    GROUP_MUTATION_INBOX_TYPES,
    isAuthenticatedGroupMutationInboxType,
} from '../group-state/inbox/group-state-inbox-contracts.ts';

import {
    createTopologyMutationAuthorityProof,
    type TopologyMutationAuthorityProof,
} from './topology-mutation-authority-proof.ts';

export {
    type AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

export {
    AUTHENTICATED_GROUP_INBOX_TYPES,
    type GroupCreateAppInboxPayload,
    type GroupDirectorAppointAppInboxPayload,
    type GroupInviteAcceptAppInboxPayload,
    type GroupInviteCreateAppInboxPayload,
    type GroupInviteRevokeAppInboxPayload,
    type GroupJoinAppInboxPayload,
    type GroupJoinCodeRotateAppInboxPayload,
    type GroupMemberBanAppInboxPayload,
    type GroupMemberRemoveAppInboxPayload,
    type GroupMemberRoleSetAppInboxPayload,
    type GroupMemberUnbanAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupOwnershipTransferAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceDisconnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload,
} from '../group-state/inbox/group-state-inbox-contracts.ts';

export type { GroupPresenceSessionCleanupAppInboxPayload } from './app-group-ws-session-lifecycle.ts';

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

interface TopologyAppInboxHandler {
    readonly processMutation: (
        context: AppInboxMessageContext,
    ) => Promise<unknown>;
}

interface RtcRttAppInboxHandler {
    readonly processMutation: (
        context: AppInboxMessageContext,
    ) => Promise<RtcRttAppInboxResult>;
}

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
    public async enqueueExpiredPresenceSessions(
        atEpochMs: number,
    ): Promise<number> {
        const preparations = await this.groupStateService.prepareExpiredPresenceMutations(
                atEpochMs,
        );
        for (const preparation of preparations) {
            await super.enqueue(toExpiredPresenceEnqueue(preparation));
        }
        return preparations.length;
    }

    public async enqueueGroupSessionCleanup(
        input: GroupPresenceSessionCleanupAppInboxPayload,
    ): Promise<number> {
        await super.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
        return 1;
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
            this.groupStateInboxHandler.toMutationDescriptor(enqueue),
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
            this.groupStateInboxHandler.toMutationDescriptor(enqueue),
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

    async enqueueRtcRtt(
        input: Readonly<{
        rtt: RttMeasurementInfo;
        alSenderId: string;
        capturedAtEpochMs: number;
        }>,
    ): Promise<ResourceEntry> {
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
        return await super.enqueue<RtcRttAppInboxCommand>({
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
            wakeQueue,
        );
        this.groupStateInboxHandler = new GroupStateInboxHandler({
            groupStateService: this.groupStateService,
            writeMutation: async (context, write) =>
                await this.writeMutation(context, write),
            wakeQueue: this.wakeQueue,
        });
        const processGroupMutation = async (
            _payload: unknown,
            context: AppInboxMessageContext,
        ) => await this.processMutation(context);
        for (const type of GROUP_MUTATION_INBOX_TYPES.filter(
            (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        )) {
            this.onStateMessage(type, processGroupMutation);
        }
        this.onStateMessage<GroupPresenceSessionCleanupAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            async (payload, context) => await processGroupSessionCleanup({
                facts: payload,
                attemptCount: context.entry.dequeueAudit.attempts,
                groupStateService: this.groupStateService,
                writeMutation: async (write) => await this.writeMutation(context, write),
                wakeQueue: this.wakeQueue,
            }),
        );
        const processTopologyMutation: TopologyAppInboxHandler['processMutation'] =
            async (context) => await this.processTopologyConfigMutation(context);
        const processTopology = async (
            _payload: unknown,
            context: AppInboxMessageContext,
        ) => await processTopologyMutation(context);
        for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
            this.onStateMessage(type, processTopology);
        }
        const processRtcRttMutation: RtcRttAppInboxHandler['processMutation'] =
            async (context) => await this.processRtcRttMutation(context);
        this.onStateMessage(
            AppInboxType.RTC_RTT_SUBMIT,
            async (_payload, context) => await processRtcRttMutation(context),
        );
    }

    private readonly groupStateInboxHandler: GroupStateInboxHandler;
    private topologyManagementService?: GroupTopologyManagementService;
    private rtcRttDependencies?: RtcRttAppInboxDependencies;

    private async processMutation(
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        return await this.groupStateInboxHandler.processMutation(context);
    }

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
        const service = requireTopologyManagementService(this.topologyManagementService);
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
        const service = requireTopologyManagementService(this.topologyManagementService);
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
            return toRtcRttAppInboxResult(computed, authority.command.requestId);
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
            session.accessTokenDigest !== await authSessionProofSecret(claimed) ||
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

}

const TOPOLOGY_CONFIG_INBOX_TYPES = [
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
] as const;

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

function constantTimeEqual(left: string, right: string): boolean {
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}
