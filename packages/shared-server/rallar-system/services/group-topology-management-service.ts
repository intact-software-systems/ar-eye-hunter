import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    toScopedGroupKey,
    toScopedOverlayId,
} from '@shared/api/api-type-utils.ts';
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
import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
    GroupTopologyConfigRepository,
} from '../repositories/GroupTopologyConfigRepository.ts';
import {
    GroupStateRepository,
    materializeGroupStateAuthorityGuard,
} from '../repositories/GroupStateRepository.ts';
import {
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    STATE_MUTATION_OUTBOX_NAMESPACE,
    StateMutationOutboxCollisionError,
    StateMutationOutboxRepository,
    stateMutationOutboxStorageKey,
    type StateMutationOutboxRecord,
} from '../repositories/StateMutationOutboxRepository.ts';
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import {
    RtcTopologySnapshotRepository,
} from '../repositories/RtcTopologySnapshotRepository.ts';
import { toRtcTopologyPublicationMessageId } from '../rtc-topology-identifiers.ts';
import {
    RtcTopologyExecutionRepository,
} from '../repositories/RtcTopologyExecutionRepository.ts';
import { compareRtcTopologyIdentifiers } from '../rtc-topology-identifiers.ts';
import {
    compareGroupCausalRevision,
    readGroupCausalRevision,
    readGroupCreatedByPrincipalId,
    readGroupMemberSessionIds,
} from '@shared/api/group-client-views.ts';
import {
    GroupStateSnapshotIncomparableError,
} from '@shared/repository/group-state-snapshots-repository.ts';
import {
    StateSnapshotRevisionConflictError,
} from '@shared/repository/state-snapshot-revision.ts';
import {
    GroupTopologyServerOptions,
    resolveGroupTopologyConfig,
    resolveOverrideExpiresAtEpochMs,
} from './group-topology-config-service.ts';
import {
    computeTopologyConfigMutation,
    type GroupTopologyConfigDeleteTarget,
    type GroupTopologyConfigMutationCommand,
    type GroupTopologyConfigMutationComputed,
    type GroupTopologyConfigMutationFacts,
    type GroupTopologyConfigMutationRead,
    type GroupTopologyConfigMutationReceipt,
    type GroupTopologyConfigMutationStableFacts,
    normalizeGroupTopologyConfigPatch,
    probeTopologyConfigMutationIdempotency,
    validateTopologyConfigMutation,
    validateTopologyConfigMutationIdempotency,
} from './group-topology-config-mutations.ts';
import {
    backfillGroupTopologyConfigGenerationsForRef,
} from './group-topology-config-generation-backfill.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    validateRuntimeStateGuardedBatch,
    validateRuntimeStateGuardedBatchResult,
} from '../../runtime-state/RuntimeStateGuardedBatch.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';
import { createInProcessMutationLane } from './in-process-mutation-lane.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult,
} from './rallar-rtc-topology-service.ts';
import {
    filterRtcRttMeasurementsForGroup,
} from './rtc-rtt-measurement-policy.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
} from './rtc-topology-mutations.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';

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
            `RTC topology predecessor changed during three commit attempts: ${JSON.stringify(groupRef)}`,
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
        super('Topology config requestId was already used for a different mutation');
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
    randomId?: () => string;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
    wakeStateMutationOutbox?: () => void;
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

export type PutGroupTopologyOverrideInput = PutGroupTopologyConfigInput & Readonly<{
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export type PutGroupTopologyConfigResult = Readonly<{
    config: StoredGroupTopologyConfig;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type PutGroupTopologyOverrideResult = Readonly<{
    override: StoredGroupTopologyOverride;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type DeleteGroupTopologyConfigResult = Readonly<{
    deleted: boolean;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type ReconcileGroupTopologyResult = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    previous: RallarOverlayTopologySnapshot | null;
    changed: boolean;
}>;

type GroupTopologyConfigMutationExecution = Readonly<{
    receipt: GroupTopologyConfigMutationReceipt;
    config?: StoredGroupTopologyConfig;
    override?: StoredGroupTopologyOverride;
}>;

export class GroupTopologyManagementService {
    private readonly topologyConfigGenerationReadiness = new Map<
        string,
        Promise<void>
    >();
    private readonly configMutationLane = createInProcessMutationLane();

    constructor(private readonly options: GroupTopologyManagementServiceOptions) {}

    recordTopologyPublication(published: boolean): void {
        this.options.topologyService.recordTopologyPublishResult(published);
    }

    async readTopologyView(
        groupRef: GroupRef,
    ): Promise<GroupTopologyManagementView> {
        const group = await this.findGroupSnapshotByRef(groupRef);
        const snapshot = this.options.topologySnapshotRepository
            ? await this.options.topologySnapshotRepository.findSnapshot(groupRef)
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

    async putConfig(
        input: PutGroupTopologyConfigInput,
    ): Promise<PutGroupTopologyConfigResult> {
        const execution = await this.executeTopologyConfigMutation({
            operation: 'putConfig',
            aggregateRef: input.groupRef,
            commandId: input.requestId ?? this.randomId(),
            requestId: input.requestId ?? null,
            input: {
                config: normalizeGroupTopologyConfigPatch(input.config),
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        if (!execution.config) {
            throw new TypeError('Topology config mutation did not return a config');
        }
        return { config: execution.config, receipt: execution.receipt };
    }

    async deleteConfig(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        const execution = await this.executeTopologyConfigMutation({
            operation: 'deleteConfig',
            aggregateRef: input.groupRef,
            commandId: input.requestId ?? this.randomId(),
            requestId: input.requestId ?? null,
            input: {
                config: null,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        return {
            deleted: execution.receipt.outcome === 'applied',
            receipt: execution.receipt,
        };
    }

    async readOverride(
        groupRef: GroupRef,
    ): Promise<StoredGroupTopologyOverride | undefined> {
        await this.ensureTopologyConfigGenerationReady(groupRef);
        return await this.options.configRepository?.findOverride(groupRef);
    }

    async putOverride(
        input: PutGroupTopologyOverrideInput,
    ): Promise<PutGroupTopologyOverrideResult> {
        const execution = await this.executeTopologyConfigMutation({
            operation: 'putOverride',
            aggregateRef: input.groupRef,
            commandId: input.requestId ?? this.randomId(),
            requestId: input.requestId ?? null,
            input: {
                config: normalizeGroupTopologyConfigPatch(input.config),
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: input.expiresAtEpochMs === undefined
                    ? input.ttlMs ?? null
                    : null,
                expiresAtEpochMs: input.expiresAtEpochMs ?? null,
            },
        });
        if (!execution.override) {
            throw new TypeError('Topology override mutation did not return an override');
        }
        return { override: execution.override, receipt: execution.receipt };
    }

    async deleteOverride(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        const execution = await this.executeTopologyConfigMutation({
            operation: 'deleteOverride',
            aggregateRef: input.groupRef,
            commandId: input.requestId ?? this.randomId(),
            requestId: input.requestId ?? null,
            input: {
                config: null,
                updatedByPrincipalId: input.updatedByPrincipalId,
                ttlMs: null,
                expiresAtEpochMs: null,
            },
        });
        return {
            deleted: execution.receipt.outcome === 'applied',
            receipt: execution.receipt,
        };
    }

    private executeTopologyConfigMutation(
        command: GroupTopologyConfigMutationCommand,
    ): Promise<GroupTopologyConfigMutationExecution> {
        return this.configMutationLane.run(
            toScopedGroupKey(command.aggregateRef),
            () => this.executeTopologyConfigMutationWithRetry(command),
        );
    }

    private async executeTopologyConfigMutationWithRetry(
        command: GroupTopologyConfigMutationCommand,
    ): Promise<GroupTopologyConfigMutationExecution> {
        const repository = this.requireConfigRepository();
        await this.ensureTopologyConfigGenerationReady(command.aggregateRef);
        const commandHash = await hashStateMutationCommand(command);
        const authorityFacts = {
            isPlatformAdmin: this.options.adminPrincipalIds?.has(
                command.input.updatedByPrincipalId,
            ) ?? false,
        } as const;
        let stableFacts: GroupTopologyConfigMutationStableFacts | undefined;
        let deleteTarget: GroupTopologyConfigDeleteTarget | null | undefined;
        let lastConflict: RuntimeStateWriteConflictError | undefined;

        for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
            const backoffMs = await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
                sleep: this.options.sleep,
            });
            let activePhase: 'read' | 'compute' | 'validate' | 'write' = 'read';
            let phaseStarted = performance.now();
            try {
                const read = await readTopologyConfigMutation(
                    repository,
                    this.requireGroupStateRepository(),
                    command,
                );
                this.recordConfigMutationPhase(command, 'read', phaseStarted, attempt, backoffMs);
                activePhase = 'compute';
                phaseStarted = performance.now();
                const idempotency = probeTopologyConfigMutationIdempotency(
                    command,
                    read,
                    commandHash,
                );
                let facts: GroupTopologyConfigMutationFacts | undefined;
                let computed: GroupTopologyConfigMutationComputed;
                if (idempotency.outcome !== 'miss') {
                    computed = idempotency;
                } else {
                    if (deleteTarget === undefined) {
                        const target = command.operation === 'deleteConfig'
                            ? read.config
                            : command.operation === 'deleteOverride'
                            ? read.override
                            : null;
                        deleteTarget = target
                            ? {
                                target: command.operation === 'deleteConfig'
                                    ? 'config'
                                    : 'override',
                                storageRevision: target.entry.revision,
                                version: target.value.version,
                                updatedAtEpochMs: target.value.updatedAtEpochMs,
                                expiresAtEpochMs: command.operation === 'deleteOverride'
                                    ? (target.value as StoredGroupTopologyOverride)
                                        .expiresAtEpochMs
                                    : null,
                            }
                            : null;
                    }
                    const policyNowEpochMs = this.now();
                    if (!stableFacts) {
                        const requestedAtEpochMs = policyNowEpochMs;
                        stableFacts = {
                            requestedAtEpochMs,
                            commandHash,
                            isPlatformAdmin: authorityFacts.isPlatformAdmin,
                            resolvedOverrideExpiresAtEpochMs:
                                command.operation === 'putOverride'
                                    ? resolveOverrideExpiresAtEpochMs({
                                        nowEpochMs: requestedAtEpochMs,
                                        ttlMs: command.input.ttlMs ?? undefined,
                                        expiresAtEpochMs:
                                            command.input.expiresAtEpochMs ?? undefined,
                                    })
                                    : null,
                            deleteTarget: deleteTarget ?? null,
                        };
                    }
                    facts = {
                        ...stableFacts,
                        policyNowEpochMs,
                        attemptCount: attempt + 1,
                    };
                    computed = computeTopologyConfigMutation({
                        command,
                        read,
                        facts,
                        serverDefaults: this.options.serverDefaults ?? {},
                    });
                }
                this.recordConfigMutationPhase(command, 'compute', phaseStarted, attempt, backoffMs);

                activePhase = 'validate';
                phaseStarted = performance.now();
                if (
                    computed.outcome === 'replay' ||
                    computed.outcome === 'idempotency-conflict'
                ) {
                    validateTopologyConfigMutationIdempotency(
                        command,
                        read,
                        commandHash,
                        authorityFacts,
                        computed,
                    );
                } else {
                    if (!facts) {
                        throw new TypeError('Topology config facts were not materialized');
                    }
                    validateTopologyConfigMutation({
                        command,
                        read,
                        facts,
                        serverDefaults: this.options.serverDefaults ?? {},
                        computed,
                    });
                }
                this.recordConfigMutationPhase(command, 'validate', phaseStarted, attempt, backoffMs);

                if (computed.outcome === 'idempotency-conflict') {
                    throw new GroupTopologyConfigIdempotencyConflictError(
                        computed.existingCommandHash,
                        computed.receivedCommandHash,
                    );
                }
                if (computed.outcome === 'replay' || computed.outcome === 'no-op') {
                    return topologyConfigExecution(computed.receipt, computed);
                }

                activePhase = 'write';
                phaseStarted = performance.now();
                const transactionStarted = performance.now();
                let written: WriteTopologyConfigMutationResult;
                try {
                    written = await writeTopologyConfigMutation(
                        requireOptimisticTopologyRuntime(repository.runtimeRepository),
                        computed,
                    );
                    if (written.status === 'conflict') {
                        throw new RuntimeStateWriteConflictError();
                    }
                    this.recordConfigMutationPhase(
                        command,
                        'transaction',
                        transactionStarted,
                        attempt,
                        backoffMs,
                    );
                } catch (error) {
                    this.recordConfigMutationPhase(
                        command,
                        'transaction',
                        transactionStarted,
                        attempt,
                        backoffMs,
                        error,
                    );
                    throw error;
                }
                this.recordConfigMutationPhase(command, 'write', phaseStarted, attempt, backoffMs);
                if (computed.outcome === 'write') this.wakeStateMutationOutbox(command);
                return topologyConfigExecution(written.receipt, computed);
            } catch (error) {
                this.recordConfigMutationPhase(
                    command,
                    activePhase,
                    phaseStarted,
                    attempt,
                    backoffMs,
                    error,
                );
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                lastConflict = error;
                recordRallarTiming(this.options.timing, {
                    component: 'group-topology-config-service',
                    operation: 'mutation.conflict',
                    serviceId: this.options.serviceId,
                    requestId: command.requestId ?? undefined,
                    ...command.aggregateRef,
                    details: {
                        attempt,
                        backoffMs,
                        conflict: true,
                        mutationOperation: command.operation,
                    },
                }, 'ok', 0);
            }
        }
        throw new RuntimeStateRetryExhaustedError(
            lastConflict ?? new RuntimeStateWriteConflictError(),
        );
    }

    async reconfigureGroupTopology(
        input: ReconfigureGroupTopologyInput,
    ): Promise<ReconfigureGroupTopologyResponse> {
        if (this.options.topologySnapshotRepository) {
            let winningConfig!: GroupTopologyConfigView;
            const committed = await this.commitTopologyWithRetry(
                input.groupRef,
                () => this.readTopologyPlanningAuthority(
                    input.groupRef,
                    input.requestOptions,
                ),
                (authority, expected) => {
                    winningConfig = authority.config;
                    return this.planTopologyFromAuthority(authority, expected);
                },
            );
            const result = committed.result;
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
                config: winningConfig,
                published,
            };
        }

        const group = input.groupSnapshot ??
            await this.findGroupSnapshotByRef(input.groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
        }

        const config = await this.readResolvedTopologyConfig(
            input.groupRef,
            input.requestOptions,
        );
        const rttMeasurements = await this.readRawRttMeasurements(group);
        const committed = { result: (() => {
            const previous = this.options.topologyService.readSnapshot(group);
            const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
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
        })(), publishable: true, group };
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
            const result = await this.planGroupTopology(group, previous);
            this.observeCommittedTopology(group, result.snapshot);
            return result;
        }

        return (await this.commitTopologyWithRetry(
            group.group,
            () => this.readTopologyPlanningAuthority(group.group),
            (authority, expected) =>
                this.planTopologyFromAuthority(authority, expected),
        )).result;
    }

    async planGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): Promise<ReconcileGroupTopologyResult> {
        const authority = await this.readTopologyPlanningAuthority(
            group.group,
            undefined,
            group,
        );
        return this.planTopologyFromAuthority(authority, previous);
    }

    async readTopologyPlanningAuthority(
        groupRef: GroupRef,
        requestOptions?: GroupTopologyConfigPatch,
        knownGroup?: GroupSnapshot,
    ): Promise<GroupTopologyPlanningAuthority> {
        const currentGroup = knownGroup
            ? await this.findTopologyPlanningGroupSnapshot(
                groupRef,
                knownGroup,
            )
            : undefined;
        const group = knownGroup
            ? selectTopologyPlanningGroup(knownGroup, currentGroup)
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

    planTopologyFromAuthority(
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
            createdByClientId: previous?.createdByClientId ??
                readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ??
                group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs,
        };
        this.validateTopology(snapshot);
        return {
            snapshot,
            previous: previous ?? null,
            changed: previous?.state !== 'removed',
        };
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
            if (!this.options.topologyService.claimDueRttTopologyUpdate(input.groupRef)) {
                return undefined;
            }
            let winningConfig!: GroupTopologyConfigView;
            const committed = await this.commitTopologyWithRetry(
                input.groupRef,
                () => this.readTopologyPlanningAuthority(input.groupRef),
                (authority, expected) => {
                    winningConfig = authority.config;
                    return this.planTopologyFromAuthority(authority, expected);
                },
            );
            const result = committed.result;
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
                config: winningConfig,
                published,
            };
        }

        const group = input.groupSnapshot ??
            await this.findGroupSnapshotByRef(input.groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
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
        const localResult = this.options.topologyService.flushDueRttTopologyUpdate(
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

    async removeGroupTopology(group: GroupSnapshot): Promise<void> {
        if (!this.options.topologySnapshotRepository) {
            this.options.topologyService.removeGroupTopology(group);
            return;
        }
        const repository = this.options.topologySnapshotRepository;
        const executionRepository = new RtcTopologyExecutionRepository(
            requireOptimisticTopologyRuntime(repository.runtimeRepository),
        );
        let lastConflict: RuntimeStateWriteConflictError | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: this.options.sleep },
            );
            const readStarted = performance.now();
            const [authority, read] = await Promise.all([
                this.readTopologyPlanningAuthority(group.group),
                executionRepository.readTopologyMutation(group.group, null),
            ]);
            const freshGroup = authority.group;
            this.recordTopologyMutationPhase(
                group.group, 'read', readStarted, attempt, backoffMs,
            );
            if (isGroupTopologyActiveAt(freshGroup, authority.nowEpochMs)) return;
            const planned = this.planTopologyFromAuthority(
                authority,
                read.snapshot?.value,
            );
            const computeStarted = performance.now();
            const mutationInput = {
                read,
                candidate: planned.snapshot,
                publication: null,
                facts: {
                    publicationExpireAtTimestamp: null,
                    commandHash: null,
                    attemptCount: null,
                },
            } as const;
            const computed = computeTopologyMutation(mutationInput);
            this.recordTopologyMutationPhase(
                group.group, 'compute', computeStarted, attempt, backoffMs,
            );
            const validateStarted = performance.now();
            validateTopologyMutation({ ...mutationInput, computed });
            this.recordTopologyMutationPhase(
                group.group, 'validate', validateStarted, attempt, backoffMs,
            );
            if (computed.outcome === 'retry') {
                lastConflict = new RuntimeStateWriteConflictError();
                continue;
            }
            if (computed.outcome === 'superseded') return;
            if (computed.outcome === 'loaded') {
                throw new TypeError('Topology removal cannot load a publication claim');
            }
            if (computed.observation === 'duplicate') {
                this.observeCommittedTopology(freshGroup, planned.snapshot);
                return;
            }
            const writeStarted = performance.now();
            const transactionStarted = performance.now();
            const written = await executionRepository.writeTopologyMutation(
                computed,
            );
            this.recordTopologyMutationPhase(
                group.group, 'transaction', transactionStarted, attempt, backoffMs,
            );
            this.recordTopologyMutationPhase(
                group.group, 'write', writeStarted, attempt, backoffMs,
            );
            if (written === 'committed') {
                this.observeCommittedTopology(freshGroup, planned.snapshot);
                return;
            }
            lastConflict = new RuntimeStateWriteConflictError();
            recordRallarTiming(this.options.timing, {
                component: 'group-topology-service',
                operation: 'topology.conflict',
                serviceId: this.options.serviceId,
                ...canonicalGroupRef(group.group),
                details: { attempt, backoffMs, conflict: true },
            }, 'ok', 0);
        }
        throw new RuntimeStateRetryExhaustedError(
            lastConflict ?? new RuntimeStateWriteConflictError(),
        );
    }

    private async commitTopologyWithRetry(
        groupRef: GroupRef,
        readAuthority: () => Promise<GroupTopologyPlanningAuthority>,
        plan: (
            authority: GroupTopologyPlanningAuthority,
            previous: RallarOverlayTopologySnapshot | undefined,
            attempt: number,
        ) => RallarRtcTopologyUpdateResult,
    ): Promise<Readonly<{
        result: RallarRtcTopologyUpdateResult;
        publishable: boolean;
        group: GroupSnapshot;
    }>> {
        const repository = this.options.topologySnapshotRepository!;
        const executionRepository = new RtcTopologyExecutionRepository(
            requireOptimisticTopologyRuntime(repository.runtimeRepository),
        );
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: this.options.sleep },
            );
            const readStarted = performance.now();
            const [authority, read] = await Promise.all([
                readAuthority(),
                executionRepository.readTopologyMutation(groupRef, null),
            ]);
            const freshGroup = authority.group;
            const result = plan(authority, read.snapshot?.value, attempt);
            this.recordTopologyMutationPhase(
                groupRef, 'read', readStarted, attempt, backoffMs,
            );
            const computeStarted = performance.now();
            const mutationInput = {
                read: {
                    snapshot: read.snapshot,
                    publicationClaim: read.publicationClaim,
                },
                candidate: result.snapshot,
                publication: null,
                facts: {
                    publicationExpireAtTimestamp: null,
                    commandHash: null,
                    attemptCount: null,
                },
            } as const;
            const computed = computeTopologyMutation(mutationInput);
            this.recordTopologyMutationPhase(
                groupRef, 'compute', computeStarted, attempt, backoffMs,
            );
            const validateStarted = performance.now();
            validateTopologyMutation({ ...mutationInput, computed });
            this.validateTopology(result.snapshot);
            this.recordTopologyMutationPhase(
                groupRef, 'validate', validateStarted, attempt, backoffMs,
            );
            if (computed.outcome === 'superseded') {
                this.observeCommittedTopology(freshGroup, computed.current);
                return {
                    result: {
                        snapshot: computed.current,
                        previous: computed.current,
                        changed: false,
                    },
                    publishable: false,
                    group: freshGroup,
                };
            }
            if (computed.outcome === 'retry') {
                recordRallarTiming(this.options.timing, {
                    component: 'group-topology-service',
                    operation: 'topology.conflict',
                    serviceId: this.options.serviceId,
                    ...canonicalGroupRef(groupRef),
                    details: {
                        attempt,
                        backoffMs,
                        conflict: true,
                        reason: computed.reason,
                    },
                }, 'ok', 0);
                continue;
            }
            if (computed.outcome === 'loaded') {
                throw new TypeError('Topology management cannot load a publication claim');
            }
            if (computed.observation !== 'duplicate') {
                const writeStarted = performance.now();
                const transactionStarted = performance.now();
                const committed = await executionRepository
                    .writeTopologyMutation(
                        computed,
                    );
                this.recordTopologyMutationPhase(
                    groupRef, 'transaction', transactionStarted, attempt, backoffMs,
                );
                this.recordTopologyMutationPhase(
                    groupRef, 'write', writeStarted, attempt, backoffMs,
                );
                if (committed === 'conflict') {
                    recordRallarTiming(this.options.timing, {
                        component: 'group-topology-service',
                        operation: 'topology.conflict',
                        serviceId: this.options.serviceId,
                        ...canonicalGroupRef(groupRef),
                        details: { attempt, backoffMs, conflict: true },
                    }, 'ok', 0);
                    continue;
                }
            }
            this.observeCommittedTopology(freshGroup, result.snapshot);
            return { result, publishable: true, group: freshGroup };
        }

        throw new GroupTopologyCommitConflictError(groupRef);
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
                    path: issue.sessionId ? ['nextHopsBySessionId', issue.sessionId] : undefined,
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
            degreeLimit: this.options.topologyService.readRttReportingDegreeLimit({
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
            return await this.options.groupStateRepository.readSnapshot(groupRef);
        }
        return await this.findGroupSnapshotByRef(groupRef, {
            minCausalRevision: readGroupCausalRevision(knownGroup),
        }) ?? await this.findGroupSnapshotByRef(groupRef);
    }

    private requireConfigRepository(): GroupTopologyConfigRepository {
        if (!this.options.configRepository) {
            throw new Error('Group topology config repository is not configured');
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
            this.options.sleep,
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

    private recordConfigMutationPhase(
        command: GroupTopologyConfigMutationCommand,
        phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
        started: number,
        attempt: number,
        backoffMs: number,
        error?: unknown,
    ): void {
        recordRallarTiming(this.options.timing, {
            component: 'group-topology-config-service',
            operation: `mutation.${phase}`,
            serviceId: this.options.serviceId,
            requestId: command.requestId ?? undefined,
            ...command.aggregateRef,
            details: { attempt, backoffMs, mutationOperation: command.operation },
        }, error === undefined ? 'ok' : 'error', performance.now() - started, error);
    }

    private recordTopologyMutationPhase(
        groupRef: GroupRef,
        phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
        started: number,
        attempt: number,
        backoffMs: number,
    ): void {
        recordRallarTiming(this.options.timing, {
            component: 'group-topology-service',
            operation: `topology.${phase}`,
            serviceId: this.options.serviceId,
            ...canonicalGroupRef(groupRef),
            details: { attempt, backoffMs },
        }, 'ok', performance.now() - started);
    }

    private wakeStateMutationOutbox(command: GroupTopologyConfigMutationCommand): void {
        const wake = this.options.wakeStateMutationOutbox;
        if (!wake) return;

        const started = performance.now();
        try {
            wake();
            recordRallarTiming(this.options.timing, {
                component: 'group-topology-config-service',
                operation: 'mutation.wake',
                serviceId: this.options.serviceId,
                requestId: command.requestId ?? undefined,
                ...command.aggregateRef,
                details: { mutationOperation: command.operation },
            }, 'ok', performance.now() - started);
        } catch (error) {
            recordRallarTiming(this.options.timing, {
                component: 'group-topology-config-service',
                operation: 'mutation.wake',
                serviceId: this.options.serviceId,
                requestId: command.requestId ?? undefined,
                ...command.aggregateRef,
                details: { mutationOperation: command.operation },
            }, 'error', performance.now() - started, error);
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

    private randomId(): string {
        return this.options.randomId?.() ?? crypto.randomUUID();
    }
}

async function readTopologyConfigMutation(
    repository: GroupTopologyConfigRepository,
    groupStateRepository: GroupStateRepository,
    command: GroupTopologyConfigMutationCommand,
): Promise<GroupTopologyConfigMutationRead> {
    const invariantBefore = await repository.findInvariantGenerationEntry(
        command.aggregateRef,
    );
    const [
        config,
        override,
        configGeneration,
        overrideGeneration,
        idempotency,
        groupObservation,
    ] = await Promise.all([
        repository.findConfigEntry(command.aggregateRef),
        repository.findOverrideEntry(command.aggregateRef),
        repository.findGenerationEntry(command.aggregateRef, 'config'),
        repository.findGenerationEntry(command.aggregateRef, 'override'),
        command.requestId === null
            ? Promise.resolve(undefined)
            : repository.findMutationRecordEntry(
                command.aggregateRef,
                command.requestId,
            ),
        groupStateRepository.readSnapshotWithAuthorityGuard(command.aggregateRef),
    ]);
    const invariantAfter = await repository.findInvariantGenerationEntry(
        command.aggregateRef,
    );
    if (!groupObservation) {
        throw new Error(`Group snapshot not found: ${command.aggregateRef.groupId}`);
    }
    if (!sameTopologyInvariantGeneration(invariantBefore, invariantAfter)) {
        throw new RuntimeStateWriteConflictError();
    }
    return {
        config: config ?? null,
        override: override ?? null,
        configGeneration: configGeneration ?? null,
        overrideGeneration: overrideGeneration ?? null,
        invariantGeneration: invariantAfter ?? null,
        idempotency: idempotency ?? null,
        groupSnapshot: groupObservation.snapshot,
        groupAuthorityGuard: groupObservation.authorityGuard,
    };
}

async function readConsistentTopologyConfigPair(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
    sleep?: (delayMs: number) => Promise<void>,
): Promise<Readonly<{
    config: Awaited<ReturnType<GroupTopologyConfigRepository['findConfigEntry']>>;
    override: Awaited<ReturnType<GroupTopologyConfigRepository['findOverrideEntry']>>;
}>> {
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, { sleep });
        const invariantBefore = await repository.findInvariantGenerationEntry(groupRef);
        const [config, override] = await Promise.all([
            repository.findConfigEntry(groupRef),
            repository.findOverrideEntry(groupRef),
        ]);
        const invariantAfter = await repository.findInvariantGenerationEntry(groupRef);
        if (sameTopologyInvariantGeneration(invariantBefore, invariantAfter)) {
            return { config, override };
        }
        lastConflict = new RuntimeStateWriteConflictError();
    }
    throw new RuntimeStateRetryExhaustedError(
        lastConflict ?? new RuntimeStateWriteConflictError(),
    );
}

function sameTopologyInvariantGeneration(
    left: Awaited<ReturnType<GroupTopologyConfigRepository['findInvariantGenerationEntry']>>,
    right: Awaited<ReturnType<GroupTopologyConfigRepository['findInvariantGenerationEntry']>>,
): boolean {
    if (!left || !right) return left === right;
    return left.entry.revision === right.entry.revision &&
        left.value.version === right.value.version;
}

function requireOptimisticTopologyRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository'],
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isOptimisticTopologyRuntime(runtime)) {
        throw new Error(
            'Group topology config mutations require an optimistic transactional repository',
        );
    }
    return runtime;
}

function isOptimisticTopologyRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository'],
): runtime is RuntimeStateOptimisticTransactionalRepositoryLike {
    return isRuntimeStateConditionalRepositoryLike(runtime) &&
        isRuntimeStateTransactionalRepositoryLike(runtime);
}

type WriteTopologyConfigMutationResult =
    | Readonly<{
        status: 'accepted';
        receipt: GroupTopologyConfigMutationReceipt;
    }>
    | Readonly<{ status: 'conflict' }>;

type MaterializedTopologyConfigGuardedBatch = Readonly<{
    batch: RuntimeStateGuardedBatch;
    outbox: StateMutationOutboxRecord | null;
}>;

function materializeTopologyConfigGuardedBatch(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    computed: Extract<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' }
    >,
): MaterializedTopologyConfigGuardedBatch {
    const repository = new GroupTopologyConfigRepository(runtime);
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    let outbox: StateMutationOutboxRecord | null = null;

    if (computed.outcome === 'write') {
        effects.push(materializeTopologyTargetEffect(repository, computed));
        effects.push(materializeTopologyInsertOrUpdateEffect({
            effectId: 'invariant-generation',
            namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            key: repository.invariantGenerationKey(computed.receipt.groupRef),
            value: computed.invariantGenerationGuard.value,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision: computed.invariantGenerationGuard.expectedRevision,
        }));
        effects.push(materializeTopologyInsertOrUpdateEffect({
            effectId: 'target-generation',
            namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            key: repository.generationKey(
                computed.receipt.groupRef,
                computed.generationGuard.value.target,
            ),
            value: computed.generationGuard.value,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision: computed.generationGuard.expectedRevision,
        }));
    }

    if (computed.idempotency) {
        effects.push({
            effectId: 'receipt',
            operation: 'insert',
            namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key: repository.mutationKey(
                computed.idempotency.groupRef,
                computed.idempotency.requestId,
            ),
            value: serializeTopologyBatchValue(computed.idempotency),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
        });
    }

    if (computed.outcome === 'write') {
        outbox = createStateMutationOutboxRecord(computed.outbox);
        effects.push({
            effectId: 'outbox',
            operation: 'insert',
            namespace: STATE_MUTATION_OUTBOX_NAMESPACE,
            key: stateMutationOutboxStorageKey(outbox.outboxId),
            value: serializeTopologyBatchValue(outbox),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
        });
    }

    return {
        batch: validateRuntimeStateGuardedBatch({
            guard: materializeGroupStateAuthorityGuard(
                computed.groupAuthorityGuard,
            ),
            effects,
        }),
        outbox,
    };
}

function materializeTopologyTargetEffect(
    repository: GroupTopologyConfigRepository,
    computed: Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' }>,
): RuntimeStateGuardedBatchEffect {
    const guard = computed.guard;
    const namespace = guard.target === 'config'
        ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
        : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
    const key = guard.target === 'config'
        ? repository.configKey(computed.receipt.groupRef)
        : repository.overrideKey(computed.receipt.groupRef);
    if (guard.operation === 'delete') {
        return {
            effectId: 'target',
            operation: 'delete',
            namespace,
            key,
            expectedRevision: guard.expectedRevision,
        };
    }
    if (guard.operation === 'insert') {
        if (guard.expectedRevision !== null) {
            throw new TypeError('Topology insert guard has an existing revision');
        }
        return {
            effectId: 'target',
            operation: 'insert',
            namespace,
            key,
            value: serializeTopologyBatchValue(guard.value),
            expireAtTimestamp: guard.target === 'config'
                ? NEVER_EXPIRE_AT_TIMESTAMP
                : guard.value.expiresAtEpochMs,
        };
    }
    if (guard.expectedRevision === null) {
        throw new TypeError('Topology update guard is missing its revision');
    }
    return {
        effectId: 'target',
        operation: 'update',
        namespace,
        key,
        expectedRevision: guard.expectedRevision,
        value: serializeTopologyBatchValue(guard.value),
        expireAtTimestamp: guard.target === 'config'
            ? NEVER_EXPIRE_AT_TIMESTAMP
            : guard.value.expiresAtEpochMs,
    };
}

function materializeTopologyInsertOrUpdateEffect(input: Readonly<{
    effectId: string;
    namespace: string;
    key: string;
    value: unknown;
    expireAtTimestamp: number;
    expectedRevision: number | null;
}>): RuntimeStateGuardedBatchEffect {
    const value = serializeTopologyBatchValue(input.value);
    return input.expectedRevision === null
        ? {
            effectId: input.effectId,
            operation: 'insert',
            namespace: input.namespace,
            key: input.key,
            value,
            expireAtTimestamp: input.expireAtTimestamp,
        }
        : {
            effectId: input.effectId,
            operation: 'update',
            namespace: input.namespace,
            key: input.key,
            expectedRevision: input.expectedRevision,
            value,
            expireAtTimestamp: input.expireAtTimestamp,
        };
}

function serializeTopologyBatchValue(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
        throw new TypeError('Topology batch value is not JSON serializable');
    }
    return serialized;
}

async function writeTopologyConfigMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    computed: Extract<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' }
    >,
): Promise<WriteTopologyConfigMutationResult> {
    const materialized = materializeTopologyConfigGuardedBatch(runtime, computed);
    try {
        return await runtime.begin(async (transaction) => {
            if (isRuntimeStateGuardedBatchRepositoryLike(transaction)) {
                const result = validateRuntimeStateGuardedBatchResult(
                    materialized.batch,
                    await transaction.executeGuardedBatch(materialized.batch),
                );
                if (result.guard.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
                for (const effect of result.effects) {
                    if (effect.status === 'applied') continue;
                    if (effect.effectId === 'outbox') {
                        if (!materialized.outbox) {
                            throw new TypeError(
                                'Topology batch outbox result has no materialized record',
                            );
                        }
                        throw new StateMutationOutboxCollisionError(
                            materialized.outbox.outboxId,
                        );
                    }
                    throw new RuntimeStateWriteConflictError();
                }
                return { status: 'accepted', receipt: computed.receipt } as const;
            }

            const repository = new GroupTopologyConfigRepository(transaction);
            const authorityFence = await new GroupStateRepository(transaction)
                .advanceAuthorityFence(computed.groupAuthorityGuard);
            if (
                authorityFence.status === 'conflict' ||
                authorityFence.revision !==
                    computed.groupAuthorityGuard.entry.revision + 1
            ) {
                throw new RuntimeStateWriteConflictError();
            }
            if (computed.outcome === 'write') {
                const guard = computed.guard;
                const state = guard.operation === 'delete'
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
                if (state.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
                const invariantGeneration =
                    await repository.commitInvariantGeneration(
                        computed.invariantGenerationGuard.value,
                        computed.invariantGenerationGuard.expectedRevision,
                    );
                if (invariantGeneration.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
                const generation = await repository.commitGeneration(
                    computed.generationGuard.value,
                    computed.generationGuard.expectedRevision,
                );
                if (generation.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }

            if (computed.idempotency) {
                const claimed = await repository.insertMutationRecord(
                    computed.idempotency,
                );
                if (claimed.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }

            if (computed.outcome === 'write') {
                if (!materialized.outbox) {
                    throw new TypeError('Topology write outbox was not materialized');
                }
                await new StateMutationOutboxRepository(transaction)
                    .insertForAuthoritativeWrite(materialized.outbox);
            }
            return { status: 'accepted', receipt: computed.receipt } as const;
        });
    } catch (error) {
        if (error instanceof RuntimeStateWriteConflictError) {
            return { status: 'conflict' };
        }
        throw error;
    }
}

function topologyConfigExecution(
    receipt: GroupTopologyConfigMutationReceipt,
    computed: Extract<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' | 'replay' | 'no-op' }
    >,
): Readonly<{
    receipt: GroupTopologyConfigMutationReceipt;
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
    return materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, {
        workId: crypto.randomUUID(),
        createdAtEpochMs: Date.now(),
    });
}

export type RtcOverlayTopologyMessageFacts = Readonly<{
    workId: string;
    createdAtEpochMs: number;
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
        facts.createdAtEpochMs < 0
    ) {
        throw new TypeError('RTC topology publication message facts are invalid');
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
    return snapshot.group.status === 'active' &&
        (snapshot.group.expiresAtEpochMs === null ||
            snapshot.group.expiresAtEpochMs > observedAtEpochMs);
}

function selectTopologyPlanningGroup(
    knownGroup: GroupSnapshot,
    currentGroup: GroupSnapshot | undefined,
): GroupSnapshot {
    if (!currentGroup) return knownGroup;
    const comparison = compareGroupCausalRevision(
        readGroupCausalRevision(currentGroup),
        readGroupCausalRevision(knownGroup),
    );
    if (comparison === 'dominates') return currentGroup;
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
    return snapshot.onlineMemberCount === snapshot.members.filter((member) =>
        member.status === 'active' &&
        activePrincipalIds.has(member.principalId)
    ).length;
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}
