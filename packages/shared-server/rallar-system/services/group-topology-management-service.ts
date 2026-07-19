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
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { GroupTopologyConfigRepository } from '../repositories/GroupTopologyConfigRepository.ts';
import {
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    StateMutationOutboxRepository,
} from '../repositories/StateMutationOutboxRepository.ts';
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import {
    RtcTopologySnapshotRepository,
} from '../repositories/RtcTopologySnapshotRepository.ts';
import {
    readGroupStateRevision,
    readGroupMemberSessionIds,
} from '@shared/api/group-client-views.ts';
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
    normalizeGroupTopologyConfigPatch,
    probeTopologyConfigMutationIdempotency,
    validateTopologyConfigMutation,
    validateTopologyConfigMutationIdempotency,
} from './group-topology-config-mutations.ts';
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
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult,
} from './rallar-rtc-topology-service.ts';
import {
    filterRtcRttMeasurementsForGroup,
} from './rtc-rtt-measurement-policy.ts';

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
    options?: Readonly<{ minSnapshotVersion?: number }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export type GroupTopologyManagementServiceOptions = Readonly<{
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    findAuthoritativeGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
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
    previous?: RallarOverlayTopologySnapshot;
    changed: boolean;
}>;

export class GroupTopologyManagementService {
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
            snapshot,
            config: await this.readConfig(groupRef),
        };
    }

    async readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView> {
        return resolveGroupTopologyConfig({
            serverOptions: this.options.serverDefaults,
            durable: await this.options.configRepository?.findConfig(groupRef),
            temporary: await this.options.configRepository?.findOverride(groupRef),
        });
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

    private async executeTopologyConfigMutation(
        command: GroupTopologyConfigMutationCommand,
    ): Promise<Readonly<{
        receipt: GroupTopologyConfigMutationReceipt;
        config?: StoredGroupTopologyConfig;
        override?: StoredGroupTopologyOverride;
    }>> {
        const repository = this.requireConfigRepository();
        const commandHash = await hashStateMutationCommand(command);
        const authorityFacts = {
            isPlatformAdmin: this.options.adminPrincipalIds?.has(
                command.input.updatedByPrincipalId,
            ) ?? false,
        } as const;
        let facts: GroupTopologyConfigMutationFacts | undefined;
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
                    this.options.findAuthoritativeGroupSnapshotByRef,
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
                    if (!facts) {
                        const nowEpochMs = this.now();
                        facts = {
                            nowEpochMs,
                            commandHash,
                            isPlatformAdmin: authorityFacts.isPlatformAdmin,
                            resolvedOverrideExpiresAtEpochMs:
                                command.operation === 'putOverride'
                                    ? resolveOverrideExpiresAtEpochMs({
                                        nowEpochMs,
                                        ttlMs: command.input.ttlMs ?? undefined,
                                        expiresAtEpochMs:
                                            command.input.expiresAtEpochMs ?? undefined,
                                    })
                                    : null,
                            deleteTarget: deleteTarget ?? null,
                        };
                    }
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
        const group = input.groupSnapshot ??
            await this.findGroupSnapshotByRef(input.groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
        }

        const config = resolveGroupTopologyConfig({
            serverOptions: this.options.serverDefaults,
            durable: await this.options.configRepository?.findConfig(input.groupRef),
            temporary: await this.options.configRepository?.findOverride(input.groupRef),
            requestOptions: input.requestOptions,
        });
        const rttMeasurements = await this.readRawRttMeasurements(group);
        const committed = this.options.topologySnapshotRepository
            ? await (async () => {
                const repository = this.options.topologySnapshotRepository!;
                const previous = await repository.findSnapshot(input.groupRef);
                return await this.commitTopologyWithRetry(
                    group,
                    previous,
                    (expected) => {
                        const filteredRttMeasurements =
                            this.filterRttMeasurementsForGroup(
                                group,
                                rttMeasurements,
                                config.effective,
                                expected,
                            );
                        return this.options.topologyService.planGroupTopology(
                            group,
                            filteredRttMeasurements,
                            {
                                previous: expected,
                                topologyOptions: config.effective,
                            },
                        );
                    },
                );
            })()
            : { result: (() => {
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
            })(), publishable: true };
        const result = committed.result;

        if (!this.options.topologySnapshotRepository) {
            this.validateTopology(result.snapshot);
        }

        const published = await this.publishIfRequested(
            group,
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

        const previous = await this.options.topologySnapshotRepository
            .findSnapshot(group.group);
        return (await this.commitTopologyWithRetry(
            group,
            previous,
            (expected) => this.planGroupTopology(group, expected),
        )).result;
    }

    async planGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): Promise<ReconcileGroupTopologyResult> {
        if (group.group.status === 'active') {
            const config = await this.readConfig(group.group);
            const rttMeasurements = await this.readRawRttMeasurements(group);
            const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                group,
                rttMeasurements,
                config.effective,
                previous,
            );
            const result = this.options.topologyService.planGroupTopology(
                group,
                filteredRttMeasurements,
                {
                    previous,
                    topologyOptions: config.effective,
                },
            );
            this.validateTopology(result.snapshot);
            return result;
        }

        const activeSessionIds = [
            ...new Set([
                ...(previous?.activeSessionIds ?? []),
                ...readGroupMemberSessionIds(group),
            ]),
        ];
        const snapshot: RallarOverlayTopologySnapshot = {
            sourceGroupStateRevision: readGroupStateRevision(group),
            state: 'removed',
            overlayId: toScopedOverlayId(group.group),
            groupRef: group.group,
            name: previous?.name ?? group.group.displayName,
            topology: previous?.topology ?? 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(
                activeSessionIds.map((sessionId) => [sessionId, []]),
            ),
            degreeLimit: previous?.degreeLimit ?? 0,
            version: previous?.version ?? 0,
            createdByClientId: previous?.createdByClientId ??
                group.group.created.byPrincipalId ?? group.group.groupId,
            createdAtEpochMs: previous?.createdAtEpochMs ??
                group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs,
        };
        this.validateTopology(snapshot);
        return {
            snapshot,
            previous,
            changed: previous?.state !== 'removed',
        };
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
        const group = input.groupSnapshot ??
            await this.findGroupSnapshotByRef(input.groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
        }

        const config = await this.readConfig(input.groupRef);
        const rttMeasurements = await this.readRawRttMeasurements(group);
        const committed = this.options.topologySnapshotRepository
            ? await (async () => {
                const repository = this.options.topologySnapshotRepository!;
                const previous = await repository.findSnapshot(input.groupRef);
                const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                    group,
                    rttMeasurements,
                    config.effective,
                    previous,
                );
                const update = this.options.topologyService.flushDueRttTopologyUpdate(
                    group,
                    filteredRttMeasurements,
                    {
                        previous,
                        topologyOptions: config.effective,
                    },
                );
                if (!update) {
                    return undefined;
                }
                return await this.commitTopologyWithRetry(
                    group,
                    previous,
                    (expected, attempt) => {
                        if (attempt === 0) {
                            return update;
                        }
                        const retryRttMeasurements =
                            this.filterRttMeasurementsForGroup(
                                group,
                                rttMeasurements,
                                config.effective,
                                expected,
                            );
                        return this.options.topologyService.planGroupTopology(
                            group,
                            retryRttMeasurements,
                            {
                                previous: expected,
                                topologyOptions: config.effective,
                            },
                        );
                    },
                );
            })()
            : (() => {
                const previous = this.options.topologyService.readSnapshot(group);
                const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                    group,
                    rttMeasurements,
                    config.effective,
                    previous,
                );
                const result = this.options.topologyService.flushDueRttTopologyUpdate(
                    group,
                    filteredRttMeasurements,
                    {
                        previous,
                        topologyOptions: config.effective,
                    },
                );
                return result ? { result, publishable: true } : undefined;
            })();
        if (!committed) {
            return undefined;
        }
        const result = committed.result;
        if (!this.options.topologySnapshotRepository) {
            this.validateTopology(result.snapshot);
        }
        const published = await this.publishIfRequested(
            group,
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
        this.options.topologyService.removeGroupTopology(group);
        if (!this.options.topologySnapshotRepository) {
            return;
        }

        await this.options.topologySnapshotRepository.withSnapshotLock(
            group.group,
            async (repository) => {
                await repository.removeSnapshot(group.group);
            },
        );
    }

    private async commitTopologyWithRetry(
        group: GroupSnapshot,
        initialPrevious: RallarOverlayTopologySnapshot | undefined,
        plan: (
            previous: RallarOverlayTopologySnapshot | undefined,
            attempt: number,
        ) => RallarRtcTopologyUpdateResult | Promise<RallarRtcTopologyUpdateResult>,
    ): Promise<Readonly<{
        result: RallarRtcTopologyUpdateResult;
        publishable: boolean;
    }>> {
        const repository = this.options.topologySnapshotRepository!;
        let expected = initialPrevious;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await plan(expected, attempt);
            this.validateTopology(result.snapshot);
            const committed = await repository.commitSnapshot({
                expected,
                candidate: result.snapshot,
            });
            if (committed.status === 'retry') {
                expected = committed.current;
                if (expected) {
                    this.observeCommittedTopology(group, expected);
                }
                continue;
            }
            if (committed.status === 'superseded') {
                this.observeCommittedTopology(group, committed.current);
                return {
                    result: {
                        snapshot: committed.current,
                        previous: committed.current,
                        changed: false,
                    },
                    publishable: false,
                };
            }

            this.observeCommittedTopology(group, committed.snapshot);
            return { result, publishable: true };
        }

        throw new GroupTopologyCommitConflictError(group.group);
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

    private async findGroupSnapshotByRef(groupRef: GroupRef): Promise<GroupSnapshot | undefined> {
        return await this.options.findGroupSnapshotByRef(groupRef);
    }

    private requireConfigRepository(): GroupTopologyConfigRepository {
        if (!this.options.configRepository) {
            throw new Error('Group topology config repository is not configured');
        }
        return this.options.configRepository;
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

    private randomId(): string {
        return this.options.randomId?.() ?? crypto.randomUUID();
    }
}

async function readTopologyConfigMutation(
    repository: GroupTopologyConfigRepository,
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader,
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
        groupSnapshot,
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
        findGroupSnapshotByRef(command.aggregateRef),
    ]);
    const invariantAfter = await repository.findInvariantGenerationEntry(
        command.aggregateRef,
    );
    if (!groupSnapshot) {
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
        groupSnapshot,
    };
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

async function writeTopologyConfigMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    computed: Extract<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' }
    >,
): Promise<WriteTopologyConfigMutationResult> {
    try {
        return await runtime.begin(async (transaction) => {
            const repository = new GroupTopologyConfigRepository(transaction);
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
                await new StateMutationOutboxRepository(transaction)
                    .insertForAuthoritativeWrite(
                        createStateMutationOutboxRecord(computed.outbox),
                    );
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

export function createRtcOverlayTopologyBroadcastMessage(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot,
): ALMessage {
    return newALBroadcastMessage(
        'rallar-server',
        newALRoute(
            AppTopics.overlayTopology,
            group.group.groupId,
            `${snapshot.overlayId}:${snapshot.sourceGroupStateRevision}:${snapshot.version}`,
        ),
        'room',
        AppTopics.overlayTopology,
        snapshot,
        {
            groupRef: group.group,
            minSnapshotVersion: group.group.snapshotVersion,
            reliability: 'best-effort',
            ack: 'none',
        },
    );
}
