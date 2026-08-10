import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigPatch,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    GroupTopologyValidationIssue,
    ReconfigureGroupTopologyResponse,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { GroupTopologyConfigRepository } from '../topology/config/persistence/\
group-topology-config-repository.ts';
import { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type * as persistence from '../group-state/persistence/group-state-persistence-contracts.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from '../repositories/RtcTopologySnapshotRepository.ts';
import { DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS } from '../repositories/RtcTopologyPublicationRepository.ts';
import { toRtcTopologyPublicationMessageId } from '../rtc-topology-identifiers.ts';
import { compareRtcTopologyIdentifiers } from '../rtc-topology-identifiers.ts';
import {
    compareGroupCausalRevision,
    readGroupCausalRevision,
    readGroupCreatedByPrincipalId,
    readGroupMemberSessionIds,
} from '@shared/api/group-client-views.ts';
import { GroupStateSnapshotIncomparableError } from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import {
    GroupTopologyServerOptions,
    resolveGroupTopologyConfig,
    resolveOverrideExpiresAtEpochMs,
} from '../topology/config/group-topology-config.ts';
import type * as mutationContracts from
    '../topology/config/mutation/group-topology-config-mutation-contracts.ts';
import * as mutationCompute from '../topology/config/mutation/compute-topology-config-mutation.ts';
import * as mutationIdempotency from
    '../topology/config/mutation/topology-config-mutation-idempotency.ts';
import * as mutationValidation from
    '../topology/config/mutation/validate-topology-config-mutation.ts';
import { readTopologyConfigMutation } from '../topology/config/mutation/\
read-topology-config-mutation.ts';
import { backfillGroupTopologyConfigGenerationsForRef } from '../topology/config/maintenance/\
backfill-group-topology-config-generations.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingSink } from './timing.ts';
import {
    RallarRtcTopologyService, type RallarRtcTopologyUpdateResult,
} from './rallar-rtc-topology-service.ts';
import { filterRtcRttMeasurementsForGroup } from './rtc-rtt-measurement-policy.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import { writeRtcTopologyOutbox } from './rtc-topology-outbox-entry.ts';
import type { ComputedRtcTopologyOutbox } from './rtc-topology-outbox-entry.ts';
import {
    canMutateActiveGroup,
    canUpdateGroupSnapshot,
    GroupPolicyDeniedError,
} from '../group-policy.ts';

export class GroupTopologyValidationError extends Error {
    readonly status = 422;
    readonly code = 'group-topology-validation-failed';

    constructor(readonly issues: readonly GroupTopologyValidationIssue[]) {
        super('Group topology validation failed');
        this.name = 'GroupTopologyValidationError';
    }
}

export class GroupTopologyCommitConflictError extends Error {
    readonly status = 503;
    readonly code = 'group-topology-commit-conflict';

    constructor(readonly groupRef: GroupRef) {
        super(
            `RTC topology predecessor changed before the queued commit: ${JSON.stringify(groupRef)}`,
        );
        this.name = 'GroupTopologyCommitConflictError';
    }
}

export class GroupTopologyConfigIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'group-topology-config-idempotency-conflict';

    constructor(
        readonly existingCommandHash: string,
        readonly receivedCommandHash: string,
    ) {
        super(
            'Topology config requestId was already used for a different mutation',
        );
        this.name = 'GroupTopologyConfigIdempotencyConflictError';
    }
}

export type GroupTopologyPublisher = (
    message: ALMessage,
    snapshot: RallarOverlayTopologySnapshot,
) => void | Promise<void>;

export type GroupTopologyGroupSnapshotReader = (
    ref: GroupRef,
    options?: Readonly<{
        minSnapshotVersion?: number;
        minCausalRevision?: GroupStateCausalRevision;
    }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export type GroupTopologyManagementServiceOptions = Readonly<{
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    groupStateRepository?: GroupStateRepository;
    configRepository?: GroupTopologyConfigRepository;
    topologyService: RallarRtcTopologyService;
    topologySnapshotRepository?: RtcTopologySnapshotRepository;
    rttRepository?: RtcRttRepository;
    processRttReader?: () => readonly RttMeasurementInfo[];
    publisher?: GroupTopologyPublisher;
    serverDefaults?: GroupTopologyServerOptions;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
    adminPrincipalIds?: ReadonlySet<string>;
}>;

export type GroupTopologyPlanningAuthority = Readonly<{
    group: GroupSnapshot;
    config: GroupTopologyConfigView;
    rttMeasurements: readonly RttMeasurementInfo[];
    nowEpochMs: number;
}>;

export type ReconfigureGroupTopologyInput = Readonly<{
    groupRef: GroupRef;
    groupSnapshot?: GroupSnapshot;
    requestOptions?: GroupTopologyConfigPatch;
    publish?: boolean;
    publisher?: GroupTopologyPublisher;
}>;

export type PutGroupTopologyConfigInput = Readonly<{
    groupRef: GroupRef;
    config: GroupTopologyConfigPatch;
    updatedByPrincipalId: string;
    requestId?: string;
}>;

export type DeleteGroupTopologyConfigInput = Readonly<{
    groupRef: GroupRef;
    updatedByPrincipalId: string;
    requestId?: string;
}>;

export type PutGroupTopologyOverrideInput = PutGroupTopologyConfigInput &
    Readonly<{
        ttlMs?: number;
        expiresAtEpochMs?: number;
    }>;

export type PutGroupTopologyConfigResult = Readonly<{
    config: StoredGroupTopologyConfig;
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type PutGroupTopologyOverrideResult = Readonly<{
    override: StoredGroupTopologyOverride;
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type DeleteGroupTopologyConfigResult = Readonly<{
    deleted: boolean;
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type ReconcileGroupTopologyResult = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    previous: RallarOverlayTopologySnapshot | null;
    changed: boolean;
}>;

export type GroupTopologyConfigMutationExecution = Readonly<{
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
    config?: StoredGroupTopologyConfig;
    override?: StoredGroupTopologyOverride;
}>;

export type GroupTopologyConfigMutationPreparation = Readonly<{
    command: mutationContracts.GroupTopologyConfigMutationCommand;
    stableFacts: mutationContracts.GroupTopologyConfigMutationStableFacts;
}>;

export type GroupTopologyConfigMutationAttemptRead = Readonly<{
    state: Awaited<ReturnType<typeof readTopologyConfigMutation>>;
    policyNowEpochMs: number;
}>;

export type GroupTopologyReconfigureCommand = Readonly<{
    groupRef: GroupRef;
    commandId: string;
    actorPrincipalId: string;
    capturedAtEpochMs: number;
    requestOptions: GroupTopologyConfigPatch;
    publish: boolean;
    isPlatformAdmin: boolean;
}>;

export type GroupTopologyReconfigureRead = Readonly<{
    authority: GroupTopologyPlanningAuthority;
    authorityGuard: persistence.GroupStateAuthorityGuard;
}>;

export type GroupTopologyReconfigureComputed = ComputedRtcTopologyOutbox &
    Readonly<{ authorityGuard: persistence.GroupStateAuthorityGuard }>;

export class GroupTopologyManagementService {
    private readonly topologyConfigGenerationReadiness = new Map<
        string,
        Promise<void>
    >();
    constructor(
        private readonly options: GroupTopologyManagementServiceOptions,
    ) {}

    recordTopologyPublication(published: boolean): void {
        this.options.topologyService.recordTopologyPublishResult(published);
    }

    isPlatformAdmin(principalId: string): boolean {
        return this.options.adminPrincipalIds?.has(principalId) ?? false;
    }

    async readTopologyView(
        groupRef: GroupRef,
    ): Promise<GroupTopologyManagementView> {
        const group = await this.findGroupSnapshotByRef(groupRef);
        const snapshot = this.options.topologySnapshotRepository
            ? await this.options.topologySnapshotRepository.findSnapshot(
                  groupRef,
              )
            : group
              ? this.options.topologyService.readSnapshot(group)
              : undefined;

        return {
            groupRef,
            overlayId: toScopedOverlayId(groupRef),
            snapshot: snapshot ?? null,
            config: await this.readConfig(groupRef),
            pending: null,
        };
    }

    async readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView> {
        return await this.readResolvedTopologyConfig(groupRef);
    }

    /** @deprecated Submit mutations through AppGroupInboxService. */
    putConfig(
        input: PutGroupTopologyConfigInput,
    ): Promise<PutGroupTopologyConfigResult> {
        void input;
        return Promise.reject(
            new TypeError('Topology config writes require AppInbox execution'),
        );
    }

    /** @deprecated Submit mutations through AppGroupInboxService. */
    deleteConfig(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        void input;
        return Promise.reject(
            new TypeError('Topology config writes require AppInbox execution'),
        );
    }

    async readOverride(
        groupRef: GroupRef,
    ): Promise<StoredGroupTopologyOverride | undefined> {
        await this.ensureTopologyConfigGenerationReady(groupRef);
        return await this.options.configRepository?.findOverride(groupRef);
    }

    /** @deprecated Submit mutations through AppGroupInboxService. */
    putOverride(
        input: PutGroupTopologyOverrideInput,
    ): Promise<PutGroupTopologyOverrideResult> {
        void input;
        return Promise.reject(
            new TypeError('Topology override writes require AppInbox execution'),
        );
    }

    /** @deprecated Submit mutations through AppGroupInboxService. */
    deleteOverride(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        void input;
        return Promise.reject(
            new TypeError('Topology override writes require AppInbox execution'),
        );
    }

    async prepareTopologyConfigMutation(
        input: Readonly<{
            command: mutationContracts.GroupTopologyConfigMutationCommand;
            commandHash: string;
            capturedAtEpochMs: number;
        }>,
    ): Promise<GroupTopologyConfigMutationPreparation> {
        const { command } = input;
        return {
            command,
            stableFacts: {
                requestedAtEpochMs: input.capturedAtEpochMs,
                commandHash: input.commandHash,
                resolvedOverrideExpiresAtEpochMs:
                    command.operation === 'putOverride'
                        ? resolveOverrideExpiresAtEpochMs({
                              nowEpochMs: input.capturedAtEpochMs,
                              ttlMs: command.input.ttlMs ?? undefined,
                              expiresAtEpochMs:
                                  command.input.expiresAtEpochMs ?? undefined,
                          })
                        : null,
            },
        };
    }

    async readTopologyConfigMutation(
        command: mutationContracts.GroupTopologyConfigMutationCommand,
    ): Promise<GroupTopologyConfigMutationAttemptRead> {
        await this.ensureTopologyConfigGenerationReady(command.aggregateRef);
        return {
            state: await readTopologyConfigMutation(
                this.requireConfigRepository(),
                this.requireGroupStateRepository(),
                command,
            ),
            policyNowEpochMs: this.now(),
        };
    }

    computeTopologyConfigMutation(
        preparation: GroupTopologyConfigMutationPreparation,
        read: GroupTopologyConfigMutationAttemptRead,
        attemptCount: number,
    ): mutationContracts.GroupTopologyConfigMutationComputed {
        const idempotency = mutationIdempotency.probeTopologyConfigMutationIdempotency(
            preparation.command,
            read.state,
            preparation.stableFacts.commandHash,
        );
        if (idempotency.outcome !== 'miss') return idempotency;
        return mutationCompute.computeTopologyConfigMutation({
            command: preparation.command,
            read: read.state,
            facts: {
                ...preparation.stableFacts,
                isPlatformAdmin: this.isPlatformAdmin(
                    preparation.command.input.updatedByPrincipalId,
                ),
                policyNowEpochMs: read.policyNowEpochMs,
                attemptCount,
            },
            serverDefaults: this.options.serverDefaults ?? {},
        });
    }

    validateTopologyConfigMutation(
        preparation: GroupTopologyConfigMutationPreparation,
        read: GroupTopologyConfigMutationAttemptRead,
        attemptCount: number,
        computed: mutationContracts.GroupTopologyConfigMutationComputed,
    ): void {
        if (
            computed.outcome === 'replay' ||
            computed.outcome === 'idempotency-conflict'
        ) {
            mutationIdempotency.validateTopologyConfigMutationIdempotency({
                command: preparation.command,
                read: read.state,
                commandHash: preparation.stableFacts.commandHash,
                authorityFacts: {
                    isPlatformAdmin: this.isPlatformAdmin(
                        preparation.command.input.updatedByPrincipalId,
                    ),
                },
                computed,
            });
            return;
        }
        mutationValidation.validateTopologyConfigMutation({
            command: preparation.command,
            read: read.state,
            facts: {
                ...preparation.stableFacts,
                isPlatformAdmin: this.isPlatformAdmin(
                    preparation.command.input.updatedByPrincipalId,
                ),
                policyNowEpochMs: read.policyNowEpochMs,
                attemptCount,
            },
            serverDefaults: this.options.serverDefaults ?? {},
            computed,
        });
    }

    async writeTopologyConfigMutation(
        transaction: PSqlTransactionSql,
        computed: Extract<
            mutationContracts.GroupTopologyConfigMutationComputed,
            {
                outcome: 'write' | 'claim';
            }
        >,
    ): Promise<mutationContracts.GroupTopologyConfigMutationReceipt> {
        return await writeTopologyConfigMutation(transaction, computed);
    }

    toTopologyConfigMutationResult(
        computed: Exclude<
            mutationContracts.GroupTopologyConfigMutationComputed,
            {
                outcome: 'idempotency-conflict';
            }
        >,
    ): GroupTopologyConfigMutationExecution {
        return topologyConfigExecution(computed.receipt, computed);
    }

    async readTopologyMutation(
        command: GroupTopologyReconfigureCommand,
    ): Promise<GroupTopologyReconfigureRead> {
        const guarded = await this.requireGroupStateRepository()
            .readSnapshotWithAuthorityGuard(command.groupRef);
        if (!guarded) {
            throw new Error(
                `Group snapshot not found: ${command.groupRef.groupId}`,
            );
        }
        const authority = await this.readTopologyPlanningAuthority(
            command.groupRef,
            command.requestOptions,
            guarded.snapshot,
        );
        if (
            compareGroupCausalRevision(
                readGroupCausalRevision(authority.group),
                readGroupCausalRevision(guarded.snapshot),
            ) !== 'equal'
        ) {
            throw new RuntimeStateWriteConflictError();
        }
        return {
            authority,
            authorityGuard: guarded.authorityGuard,
        };
    }

    computeTopologyMutation(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead,
    ): GroupTopologyReconfigureComputed {
        const snapshot = read.authority.group;
        return {
            authorityGuard: read.authorityGuard,
            commandId: command.commandId,
            resourceId: `${command.commandId}:rtc-topology-recompute:explicit`,
            aggregateRef: command.groupRef,
            acceptedCausalRevision: snapshot.causalRevision,
            groupSnapshot: snapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: 253_402_300_799_999,
            senderId: command.actorPrincipalId,
            requestOptions: toCanonicalGroupTopologyConfigPatch(
                command.requestOptions,
            ),
            publish: command.publish,
        };
    }

    validateTopologyMutation(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead,
        computed: GroupTopologyReconfigureComputed,
    ): void {
        const lifecycle = canMutateActiveGroup({
            group: read.authority.group.group,
            nowEpochMs: read.authority.nowEpochMs,
        });
        if (!lifecycle.allowed) throw new GroupPolicyDeniedError(lifecycle);
        if (!command.isPlatformAdmin) {
            const policy = canUpdateGroupSnapshot({
                snapshot: read.authority.group,
                actor: { principalId: command.actorPrincipalId },
                nowEpochMs: read.authority.nowEpochMs,
            });
            if (!policy.allowed) throw new GroupPolicyDeniedError(policy);
        }
        if (
            computed.commandId !== command.commandId ||
            computed.groupSnapshot !== read.authority.group ||
            computed.authorityGuard !== read.authorityGuard ||
            JSON.stringify(computed.requestOptions) !== JSON.stringify(
                toCanonicalGroupTopologyConfigPatch(command.requestOptions),
            ) ||
            computed.publish !== command.publish
        ) {
            throw new TypeError('Topology reconfigure computation is invalid');
        }
    }

    async writeTopologyMutation(
        transaction: PSqlTransactionSql,
        computed: GroupTopologyReconfigureComputed,
    ): Promise<void> {
        const runtime = new PSqlRuntimeStateRepository(transaction);
        const authority = await new GroupStateRepository(runtime)
            .advanceAuthorityFence(computed.authorityGuard);
        if (
            authority.status === 'conflict' ||
            authority.revision !== computed.authorityGuard.entry.revision + 1
        ) {
            throw new RuntimeStateWriteConflictError();
        }
        await writeRtcTopologyOutbox(transaction, computed);
    }

    async reconfigureGroupTopology(
        input: ReconfigureGroupTopologyInput,
    ): Promise<ReconfigureGroupTopologyResponse> {
        if (this.options.topologySnapshotRepository) {
            throw new TypeError(
                'Topology reconfiguration requires AppInbox execution',
            );
        }

        const group =
            input.groupSnapshot ??
            (await this.findGroupSnapshotByRef(input.groupRef));
        if (!group) {
            throw new Error(
                `Group snapshot not found: ${input.groupRef.groupId}`,
            );
        }

        const config = await this.readResolvedTopologyConfig(
            input.groupRef,
            input.requestOptions,
        );
        const rttMeasurements = await this.readRawRttMeasurements(group);
        const committed = {
            result: (() => {
                const previous =
                    this.options.topologyService.readSnapshot(group);
                const filteredRttMeasurements =
                    this.filterRttMeasurementsForGroup(
                        group,
                        rttMeasurements,
                        config.effective,
                previous,
            );
            return this.options.topologyService.updateGroupTopology(
                group,
                filteredRttMeasurements,
                {
                    previous,
                        topologyOptions: config.effective,
                    },
                );
            })(),
            publishable: true,
            group,
        };
        const result = committed.result;

        this.validateTopology(result.snapshot);

        const published = await this.publishIfRequested(
            committed.group,
            result,
            input.publisher,
            (input.publish ?? true) && committed.publishable,
        );

        return {
            groupRef: input.groupRef,
            overlayId: result.snapshot.overlayId,
            changed: result.changed,
            snapshot: result.snapshot,
            previous: result.previous,
            config,
            published,
        };
    }

    async reconcileGroupTopology(
        group: GroupSnapshot,
    ): Promise<ReconcileGroupTopologyResult> {
        if (!this.options.topologySnapshotRepository) {
            const previous = this.options.topologyService.readSnapshot(group);
            const result = await this.computeGroupTopology(group, previous);
            this.observeCommittedTopology(group, result.snapshot);
            return result;
        }

        throw new TypeError(
            'Persistent topology reconciliation requires APP_OUTBOX',
        );
    }

    async computeGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): Promise<ReconcileGroupTopologyResult> {
        const authority = await this.readTopologyPlanningAuthority(
            group.group,
            undefined,
            group,
        );
        return this.computeTopologyFromAuthority(authority, previous);
    }

    /** @deprecated Use computeGroupTopology. */
    async planGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): Promise<ReconcileGroupTopologyResult> {
        return await this.computeGroupTopology(group, previous);
    }
    async readTopologyPlanningAuthority(
        groupRef: GroupRef,
        requestOptions?: GroupTopologyConfigPatch,
        knownGroup?: GroupSnapshot,
        useKnownGroupRevision: boolean = false,
    ): Promise<GroupTopologyPlanningAuthority> {
        const currentGroup = knownGroup
            ? await this.findTopologyPlanningGroupSnapshot(groupRef, knownGroup)
            : undefined;
        const group = knownGroup
            ? selectTopologyPlanningGroup(knownGroup, currentGroup, useKnownGroupRevision)
            : await this.findCurrentGroupSnapshot(groupRef);
        const [config, rttMeasurements] = await Promise.all([
            this.readResolvedTopologyConfig(group.group, requestOptions),
            this.readRawRttMeasurements(group),
        ]);
        return {
            group,
            config,
            rttMeasurements,
            nowEpochMs: this.options.topologyService.readNowEpochMs(),
        };
    }
    computeTopologyFromAuthority(
        authority: GroupTopologyPlanningAuthority,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): ReconcileGroupTopologyResult {
        const group = authority.group;
        if (isGroupTopologyActiveAt(group, authority.nowEpochMs)) {
            const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                group,
                authority.rttMeasurements,
                authority.config.effective,
                previous,
            );
            const result = this.options.topologyService.planGroupTopologyAt(
                group,
                filteredRttMeasurements,
                {
                    previous,
                    topologyOptions: authority.config.effective,
                },
                authority.nowEpochMs,
            );
            this.validateTopology(result.snapshot);
            return result;
        }

        const activeSessionIds = [
            ...new Set([
                ...(previous?.activeSessionIds ?? []),
                ...readGroupMemberSessionIds(group),
            ]),
        ].sort(compareRtcTopologyIdentifiers);
        const snapshot: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: readGroupCausalRevision(group),
            state: 'removed',
            overlayId: toScopedOverlayId(group.group),
            groupRef: canonicalGroupRef(group.group),
            name: previous?.name ?? group.group.displayName,
            topology: previous?.topology ?? 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(
                activeSessionIds.map((sessionId) => [sessionId, []]),
            ),
            degreeLimit: previous?.degreeLimit ?? 1,
            version: previous?.version ?? 0,
            createdByClientId:
                previous?.createdByClientId ??
                readGroupCreatedByPrincipalId(group),
            createdAtEpochMs:
                previous?.createdAtEpochMs ?? group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs,
        };
        this.validateTopology(snapshot);
        return {
            snapshot,
            previous: previous ?? null,
            changed: previous?.state !== 'removed',
        };
    }

    /** @deprecated Use computeTopologyFromAuthority. */
    planTopologyFromAuthority(
        authority: GroupTopologyPlanningAuthority,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): ReconcileGroupTopologyResult {
        return this.computeTopologyFromAuthority(authority, previous);
    }

    async findCurrentGroupSnapshot(groupRef: GroupRef): Promise<GroupSnapshot> {
        const group = await this.findGroupSnapshotByRef(groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${groupRef.groupId}`);
        }
        return group;
    }

    observeCommittedTopology(
        group: GroupSnapshot,
        snapshot: RallarOverlayTopologySnapshot,
    ): void {
        if (snapshot.state === 'removed') {
            this.options.topologyService.removeGroupTopology(group);
            return;
        }
        this.options.topologyService.observeCommittedTopologySnapshot(snapshot);
    }

    async flushDueGroupTopology(
        input: ReconfigureGroupTopologyInput,
    ): Promise<ReconfigureGroupTopologyResponse | undefined> {
        if (this.options.topologySnapshotRepository) {
            return undefined;
        }

        const group =
            input.groupSnapshot ??
            (await this.findGroupSnapshotByRef(input.groupRef));
        if (!group) {
            throw new Error(
                `Group snapshot not found: ${input.groupRef.groupId}`,
            );
        }

        const config = await this.readConfig(input.groupRef);
        const rttMeasurements = await this.readRawRttMeasurements(group);
        const previous = this.options.topologyService.readSnapshot(group);
        const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
            group,
            rttMeasurements,
            config.effective,
            previous,
        );
        const localResult =
            this.options.topologyService.flushDueRttTopologyUpdate(
                group,
                filteredRttMeasurements,
                {
                previous,
                topologyOptions: config.effective,
            },
        );
        const committed = localResult
            ? { result: localResult, publishable: true, group }
            : undefined;
        if (!committed) {
            return undefined;
        }
        const result = committed.result;
        if (!this.options.topologySnapshotRepository) {
            this.validateTopology(result.snapshot);
        }
        const published = await this.publishIfRequested(
            committed.group,
            result,
            input.publisher,
            (input.publish ?? true) && committed.publishable,
        );

        return {
            groupRef: input.groupRef,
            overlayId: result.snapshot.overlayId,
            changed: result.changed,
            snapshot: result.snapshot,
            previous: result.previous,
            config,
            published,
        };
    }

    removeGroupTopology(group: GroupSnapshot): Promise<void> {
        if (!this.options.topologySnapshotRepository) {
            this.options.topologyService.removeGroupTopology(group);
        }
        // Persistent removal converges through the immutable topology APP_OUTBOX lane.
        return Promise.resolve();
    }

    private validateTopology(snapshot: RallarOverlayTopologySnapshot): void {
        if (snapshot.state === 'removed') {
            return;
        }
        const result = validateGroupTopologyNextHops({
            activeSessionIds: new Set(snapshot.activeSessionIds),
            nextHopsBySessionId: snapshot.nextHopsBySessionId,
            maxDegree: snapshot.degreeLimit,
        });

        if (!result.valid) {
            throw new GroupTopologyValidationError(
                result.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.sessionId
                        ? ['nextHopsBySessionId', issue.sessionId]
                        : undefined,
                    message: issue.code,
                    details: issue,
                })),
            );
        }
    }

    private async publishIfRequested(
        group: GroupSnapshot,
        result: RallarRtcTopologyUpdateResult,
        publisher: GroupTopologyPublisher | undefined,
        publish: boolean,
    ): Promise<boolean> {
        if (!publish) {
            return false;
        }

        const resolvedPublisher = publisher ?? this.options.publisher;
        if (!resolvedPublisher) {
            this.options.topologyService.recordTopologyPublishResult(false);
            return false;
        }

        await resolvedPublisher(
            createRtcOverlayTopologyBroadcastMessage(group, result.snapshot),
            result.snapshot,
        );
        this.options.topologyService.recordTopologyPublishResult(true);
        return true;
    }

    private filterRttMeasurementsForGroup(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        topologyOptions: EffectiveGroupTopologyConfig,
        overlaySnapshot: RallarOverlayTopologySnapshot | undefined,
    ): readonly RttMeasurementInfo[] {
        if (rttMeasurements.length === 0) {
            return rttMeasurements;
        }

        return filterRtcRttMeasurementsForGroup({
            group,
            rttMeasurements,
            overlaySnapshot,
            degreeLimit:
                this.options.topologyService.readRttReportingDegreeLimit({
                    ...topologyOptions,
                    rttReportingDegreeLimit:
                        this.options.serverDefaults?.rttReportingDegreeLimit,
            }),
        });
    }

    private async readRawRttMeasurements(
        group: GroupSnapshot,
    ): Promise<readonly RttMeasurementInfo[]> {
        if (this.options.rttRepository) {
            return await this.options.rttRepository.listMeasurementsForSessionIds(
                group.activeSessions.map((session) => session.sessionId),
            );
        }

        return this.options.processRttReader?.() ?? rttRepository.getAllRtt();
    }

    private async findGroupSnapshotByRef(
        groupRef: GroupRef,
        options?: Readonly<{
            minSnapshotVersion?: number;
            minCausalRevision?: GroupStateCausalRevision;
        }>,
    ): Promise<GroupSnapshot | undefined> {
        return await this.options.findGroupSnapshotByRef(groupRef, options);
    }

    private async findTopologyPlanningGroupSnapshot(
        groupRef: GroupRef,
        knownGroup: GroupSnapshot,
    ): Promise<GroupSnapshot | undefined> {
        if (this.options.groupStateRepository) {
            return await this.options.groupStateRepository.readSnapshot(
                groupRef,
            );
        }
        return (
            (await this.findGroupSnapshotByRef(groupRef, {
                minCausalRevision: readGroupCausalRevision(knownGroup),
            })) ?? (await this.findGroupSnapshotByRef(groupRef))
        );
    }

    private requireConfigRepository(): GroupTopologyConfigRepository {
        if (!this.options.configRepository) {
            throw new Error(
                'Group topology config repository is not configured',
            );
        }
        return this.options.configRepository;
    }

    private async readResolvedTopologyConfig(
        groupRef: GroupRef,
        requestOptions?: GroupTopologyConfigPatch,
    ): Promise<GroupTopologyConfigView> {
        const repository = this.options.configRepository;
        if (!repository) {
            return resolveGroupTopologyConfig({
                serverOptions: this.options.serverDefaults,
                requestOptions,
            });
        }
        await this.ensureTopologyConfigGenerationReady(groupRef);
        const { config, override } = await readConsistentTopologyConfigPair(
            repository,
            groupRef,
        );
        return resolveGroupTopologyConfig({
            serverOptions: this.options.serverDefaults,
            durable: config?.value,
            temporary: override?.value,
            requestOptions,
        });
    }

    private async ensureTopologyConfigGenerationReady(
        groupRef: GroupRef,
    ): Promise<void> {
        const repository = this.options.configRepository;
        if (!repository) return;
        const key = toScopedOverlayId(groupRef);
        let readiness = this.topologyConfigGenerationReadiness.get(key);
        if (!readiness) {
            readiness = backfillGroupTopologyConfigGenerationsForRef(
                repository,
                groupRef,
                { sleep: this.options.sleep },
            ).then(() => undefined);
            this.topologyConfigGenerationReadiness.set(key, readiness);
        }
        try {
            await readiness;
        } catch (error) {
            if (this.topologyConfigGenerationReadiness.get(key) === readiness) {
                this.topologyConfigGenerationReadiness.delete(key);
            }
            throw error;
        }
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private requireGroupStateRepository(): GroupStateRepository {
        if (!this.options.groupStateRepository) {
            throw new TypeError(
                'Topology config mutations require a production group-state repository',
            );
        }
        return this.options.groupStateRepository;
    }
}

async function readConsistentTopologyConfigPair(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
): Promise<
    Readonly<{
        config: Awaited<
            ReturnType<GroupTopologyConfigRepository['findConfigEntry']>
        >;
        override: Awaited<
            ReturnType<GroupTopologyConfigRepository['findOverrideEntry']>
        >;
    }>
> {
    const exact = await repository.readMutationExactEntries(groupRef, null);
    if (exact.status === 'stable') {
        return {
            config: exact.config ?? undefined,
            override: exact.override ?? undefined,
        };
    }
    const [config, override] = await Promise.all([
        repository.findConfigEntry(groupRef),
        repository.findOverrideEntry(groupRef),
    ]);
    return { config, override };
}

export async function writeTopologyConfigMutation(
    transaction: PSqlTransactionSql,
    computed: Extract<
        mutationContracts.GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' }
    >,
): Promise<mutationContracts.GroupTopologyConfigMutationReceipt> {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const repository = new GroupTopologyConfigRepository(runtime);
    const authorityFence = await new GroupStateRepository(
        runtime,
    ).advanceAuthorityFence(computed.groupAuthorityGuard);
    if (
        authorityFence.status === 'conflict' ||
        authorityFence.revision !==
            computed.groupAuthorityGuard.entry.revision + 1
    ) {
        throw new RuntimeStateWriteConflictError();
    }
    if (computed.outcome === 'write') {
        const guard = computed.guard;
        const state =
            guard.operation === 'delete'
                ? guard.target === 'config'
                    ? await repository.deleteConfig(
                          computed.receipt.groupRef,
                          guard.expectedRevision,
                      )
                    : await repository.deleteOverride(
                          computed.receipt.groupRef,
                          guard.expectedRevision,
                      )
                : guard.target === 'config'
                    ? await repository.commitConfig(
                          guard.value,
                          guard.expectedRevision,
                      )
                    : await repository.commitOverride(
                          guard.value,
                          guard.expectedRevision,
                      );
        requireAcceptedTopologyConfigWrite(state);
        requireAcceptedTopologyConfigWrite(
            await repository.commitInvariantGeneration(
                computed.invariantGenerationGuard.value,
                computed.invariantGenerationGuard.expectedRevision,
            ),
        );
        requireAcceptedTopologyConfigWrite(
            await repository.commitGeneration(
                computed.generationGuard.value,
                computed.generationGuard.expectedRevision,
            ),
        );
    }
    if (computed.idempotency) {
        requireAcceptedTopologyConfigWrite(
            await repository.insertMutationRecord(computed.idempotency),
        );
    }
    if (computed.outcome === 'write') {
        await writeRtcTopologyOutbox(transaction, computed.outbox);
    }
    return computed.receipt;
}

function requireAcceptedTopologyConfigWrite(
    result: Readonly<{ status: 'accepted' | 'conflict' }>,
): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

function topologyConfigExecution(
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt,
    computed: Extract<
        mutationContracts.GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' | 'replay' | 'no-op' }
    >,
): Readonly<{
    receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
    config?: StoredGroupTopologyConfig;
    override?: StoredGroupTopologyOverride;
}> {
    return computed.result.kind === 'config'
        ? { receipt, config: computed.result.config }
        : computed.result.kind === 'override'
        ? { receipt, override: computed.result.override }
        : { receipt };
}

/**
 * @deprecated Compatibility helper for non-retry publication paths only.
 * Retryable writes must use materializeRtcOverlayTopologyBroadcastMessage.
 */
export function createRtcOverlayTopologyBroadcastMessage(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot,
): ALMessage {
    const createdAtEpochMs = Date.now();
    return materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, {
        workId: crypto.randomUUID(),
        createdAtEpochMs,
        expiresAtEpochMs:
            createdAtEpochMs + DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    });
}

export type RtcOverlayTopologyMessageFacts = Readonly<{
    workId: string;
    createdAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

/**
 * Pure persisted-message seam. Retry loops must materialize immutable facts
 * before attempt zero and reuse those facts for every recomputation.
 */
export function materializeRtcOverlayTopologyBroadcastMessage(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot,
    facts: RtcOverlayTopologyMessageFacts,
): ALMessage {
    if (
        facts.workId.length === 0 ||
        !Number.isSafeInteger(facts.createdAtEpochMs) ||
        facts.createdAtEpochMs < 0 ||
        !Number.isSafeInteger(facts.expiresAtEpochMs) ||
        facts.expiresAtEpochMs <= facts.createdAtEpochMs
    ) {
        throw new TypeError(
            'RTC topology publication message facts are invalid',
        );
    }
    return {
        id: {
            v: 2,
            msgId: toRtcTopologyPublicationMessageId(facts.workId),
            ts: facts.createdAtEpochMs,
            senderId: 'rallar-server',
        },
        route: {
            topicId: AppTopics.overlayTopology,
            contextId: group.group.groupId,
            resourceId:
                `${snapshot.overlayId}:` +
                `${snapshot.sourceGroupStateCausalRevision.groupRevision}:` +
                `${snapshot.sourceGroupStateCausalRevision.presenceRevision}:` +
                `${snapshot.version}`,
        },
        constraints: { expiresAtMs: facts.expiresAtEpochMs },
        targets: {
            mode: 'broadcast',
            scope: 'room',
            groupRef: canonicalGroupRef(group.group),
            minSnapshotVersion: group.group.snapshotVersion,
        },
        delivery: {
            reliability: 'best-effort',
            ack: 'none',
        },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json',
            resource: JSON.stringify(snapshot),
        },
        audit: {
            createdBy: 'rallar-server',
            createdTs: facts.createdAtEpochMs,
        },
    };
}

function isGroupTopologyActiveAt(
    snapshot: GroupSnapshot,
    observedAtEpochMs: number,
): boolean {
    return (
        snapshot.group.status === 'active' &&
        (snapshot.group.expiresAtEpochMs === null ||
            snapshot.group.expiresAtEpochMs > observedAtEpochMs)
    );
}

function selectTopologyPlanningGroup(
    knownGroup: GroupSnapshot,
    currentGroup: GroupSnapshot | undefined,
    useKnownGroupRevision: boolean,
): GroupSnapshot {
    if (!currentGroup) return knownGroup;
    const comparison = compareGroupCausalRevision(
        readGroupCausalRevision(currentGroup),
        readGroupCausalRevision(knownGroup),
    );
    if (comparison === 'dominates') return useKnownGroupRevision ? knownGroup : currentGroup;
    if (comparison === 'dominated') return knownGroup;
    if (comparison === 'incomparable') {
        throw new GroupStateSnapshotIncomparableError(knownGroup.group);
    }
    if (
        !rtcTopologySemanticEqual(currentGroup, knownGroup) &&
        !isTuplePreservingGroupLivenessReduction(currentGroup, knownGroup)
    ) {
        throw new StateSnapshotRevisionConflictError(
            'Group',
            knownGroup.stateRevision,
        );
    }
    return currentGroup;
}

function isTuplePreservingGroupLivenessReduction(
    currentGroup: GroupSnapshot,
    knownGroup: GroupSnapshot,
): boolean {
    const {
        activeSessions: currentSessions,
        onlineMemberCount: _currentOnlineMemberCount,
        ...currentAuthority
    } = currentGroup;
    const {
        activeSessions: knownSessions,
        onlineMemberCount: _knownOnlineMemberCount,
        ...knownAuthority
    } = knownGroup;
    if (
        !rtcTopologySemanticEqual(currentAuthority, knownAuthority) ||
        !hasConsistentGroupOnlineMemberCount(currentGroup) ||
        !hasConsistentGroupOnlineMemberCount(knownGroup)
    ) {
        return false;
    }

    const knownSessionsById = new Map(
        knownSessions.map((session, index) => [
            session.sessionId,
            { index, session },
        ]),
    );
    if (
        knownSessionsById.size !== knownSessions.length ||
        new Set(currentSessions.map((session) => session.sessionId)).size !==
            currentSessions.length
    ) {
        return false;
    }
    let previousKnownIndex = -1;
    for (const currentSession of currentSessions) {
        const known = knownSessionsById.get(currentSession.sessionId);
        if (
            !known ||
            known.index <= previousKnownIndex ||
            !rtcTopologySemanticEqual(currentSession, known.session)
        ) {
            return false;
        }
        previousKnownIndex = known.index;
    }
    return true;
}

function hasConsistentGroupOnlineMemberCount(snapshot: GroupSnapshot): boolean {
    const activePrincipalIds = new Set(
        snapshot.activeSessions.map((session) => session.principalId),
    );
    return (
        snapshot.onlineMemberCount ===
        snapshot.members.filter(
            (member) =>
                member.status === 'active' &&
                activePrincipalIds.has(member.principalId),
        ).length
    );
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}
