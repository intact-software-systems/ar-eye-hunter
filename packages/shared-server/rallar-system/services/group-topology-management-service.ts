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
import { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import {
    RtcTopologySnapshotRepository,
    type RtcTopologySnapshotObservation,
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
    configRepository?: GroupTopologyConfigRepository;
    topologyService: RallarRtcTopologyService;
    topologySnapshotRepository?: RtcTopologySnapshotRepository;
    rttRepository?: RtcRttRepository;
    processRttReader?: () => readonly RttMeasurementInfo[];
    publisher?: GroupTopologyPublisher;
    serverDefaults?: GroupTopologyServerOptions;
    now?: () => number;
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
    reconfigure?: boolean;
    publish?: boolean;
}>;

export type DeleteGroupTopologyConfigInput = Readonly<{
    groupRef: GroupRef;
    updatedByPrincipalId: string;
    reconfigure?: boolean;
    publish?: boolean;
}>;

export type PutGroupTopologyOverrideInput = PutGroupTopologyConfigInput & Readonly<{
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export type PutGroupTopologyConfigResult = Readonly<{
    config: StoredGroupTopologyConfig;
    reconfigure?: ReconfigureGroupTopologyResponse;
}>;

export type PutGroupTopologyOverrideResult = Readonly<{
    override: StoredGroupTopologyOverride;
    reconfigure?: ReconfigureGroupTopologyResponse;
}>;

export type DeleteGroupTopologyConfigResult = Readonly<{
    deleted: boolean;
    reconfigure?: ReconfigureGroupTopologyResponse;
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
        this.requireConfigRepository();
        const current = await this.options.configRepository!.findConfig(input.groupRef);
        const now = this.now();
        const config: StoredGroupTopologyConfig = {
            groupRef: input.groupRef,
            config: input.config,
            version: (current?.version ?? 0) + 1,
            createdAtEpochMs: current?.createdAtEpochMs ?? now,
            updatedAtEpochMs: now,
            updatedByPrincipalId: input.updatedByPrincipalId,
            requestId: input.requestId,
        };
        resolveGroupTopologyConfig({
            serverOptions: this.options.serverDefaults,
            durable: config,
            temporary: await this.options.configRepository!.findOverride(input.groupRef),
        });
        await this.options.configRepository!.putConfig(config);

        if (!(input.reconfigure ?? true)) {
            return { config };
        }

        try {
            return {
                config,
                reconfigure: await this.reconfigureGroupTopology({
                    groupRef: input.groupRef,
                    publish: input.publish,
                }),
            };
        } catch (error) {
            await this.restoreConfig(input.groupRef, current);
            throw error;
        }
    }

    async deleteConfig(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        this.requireConfigRepository();
        const existing = await this.options.configRepository!.findConfig(input.groupRef);
        await this.options.configRepository!.deleteConfig(input.groupRef);

        if (!(input.reconfigure ?? true)) {
            return { deleted: existing !== undefined };
        }

        try {
            return {
                deleted: existing !== undefined,
                reconfigure: await this.reconfigureGroupTopology({
                    groupRef: input.groupRef,
                    publish: input.publish,
                }),
            };
        } catch (error) {
            await this.restoreConfig(input.groupRef, existing);
            throw error;
        }
    }

    async readOverride(
        groupRef: GroupRef,
    ): Promise<StoredGroupTopologyOverride | undefined> {
        return await this.options.configRepository?.findOverride(groupRef);
    }

    async putOverride(
        input: PutGroupTopologyOverrideInput,
    ): Promise<PutGroupTopologyOverrideResult> {
        this.requireConfigRepository();
        const current = await this.options.configRepository!.findOverride(input.groupRef);
        const now = this.now();
        const expiresAtEpochMs = resolveOverrideExpiresAtEpochMs({
            nowEpochMs: now,
            ttlMs: input.ttlMs,
            expiresAtEpochMs: input.expiresAtEpochMs,
        });
        const override: StoredGroupTopologyOverride = {
            groupRef: input.groupRef,
            config: input.config,
            version: (current?.version ?? 0) + 1,
            createdAtEpochMs: current?.createdAtEpochMs ?? now,
            updatedAtEpochMs: now,
            updatedByPrincipalId: input.updatedByPrincipalId,
            requestId: input.requestId,
            expiresAtEpochMs,
        };
        resolveGroupTopologyConfig({
            serverOptions: this.options.serverDefaults,
            durable: await this.options.configRepository!.findConfig(input.groupRef),
            temporary: override,
        });
        await this.options.configRepository!.putOverride(override, expiresAtEpochMs);

        if (!(input.reconfigure ?? true)) {
            return { override };
        }

        try {
            return {
                override,
                reconfigure: await this.reconfigureGroupTopology({
                    groupRef: input.groupRef,
                    publish: input.publish,
                }),
            };
        } catch (error) {
            await this.restoreOverride(input.groupRef, current);
            throw error;
        }
    }

    async deleteOverride(
        input: DeleteGroupTopologyConfigInput,
    ): Promise<DeleteGroupTopologyConfigResult> {
        this.requireConfigRepository();
        const existing = await this.options.configRepository!.findOverride(input.groupRef);
        await this.options.configRepository!.deleteOverride(input.groupRef);

        if (!(input.reconfigure ?? true)) {
            return { deleted: existing !== undefined };
        }

        try {
            return {
                deleted: existing !== undefined,
                reconfigure: await this.reconfigureGroupTopology({
                    groupRef: input.groupRef,
                    publish: input.publish,
                }),
            };
        } catch (error) {
            await this.restoreOverride(input.groupRef, existing);
            throw error;
        }
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
        const result = this.options.topologySnapshotRepository
            ? await (async () => {
                const repository = this.options.topologySnapshotRepository!;
                const previous = await repository.findSnapshot(input.groupRef);
                const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                    group,
                    rttMeasurements,
                    config.effective,
                    previous,
                );
                const update = this.options.topologyService.updateGroupTopology(
                    group,
                    filteredRttMeasurements,
                    {
                        previous,
                        topologyOptions: config.effective,
                    },
                );
                const observation = await this.validateAndPersist(
                    update,
                    repository,
                );
                if (observation === 'stale' && previous) {
                    this.options.topologyService.observeTopologySnapshot(previous);
                }
                return update;
            })()
            : (() => {
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
            })();

        if (!this.options.topologySnapshotRepository) {
            this.validateTopology(result.snapshot);
        }

        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true,
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
        const previous = this.options.topologySnapshotRepository
            ? await this.options.topologySnapshotRepository.findSnapshot(group.group)
            : this.options.topologyService.readSnapshot(group);
        const result = await this.planGroupTopology(group, previous);
        const observation = await this.options.topologySnapshotRepository
            ?.observeSnapshot(result.snapshot);
        if (observation === 'stale' && previous) {
            this.options.topologyService.observeTopologySnapshot(previous);
            return { snapshot: previous, previous, changed: false };
        }
        this.observeCommittedTopology(group, result.snapshot);
        return result;
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
        this.options.topologyService.observeTopologySnapshot(snapshot);
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
        const result = this.options.topologySnapshotRepository
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
                if (update) {
                    this.validateTopology(update.snapshot);
                    const observation = await repository.observeSnapshot(
                        update.snapshot,
                    );
                    if (observation === 'stale' && previous) {
                        this.options.topologyService.observeTopologySnapshot(previous);
                    }
                }
                return update;
            })()
            : (() => {
                const previous = this.options.topologyService.readSnapshot(group);
                const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
                    group,
                    rttMeasurements,
                    config.effective,
                    previous,
                );
                return this.options.topologyService.flushDueRttTopologyUpdate(
                    group,
                    filteredRttMeasurements,
                    {
                        previous,
                        topologyOptions: config.effective,
                    },
                );
            })();
        if (!result) {
            return undefined;
        }
        if (!this.options.topologySnapshotRepository) {
            this.validateTopology(result.snapshot);
        }
        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true,
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

    private async validateAndPersist(
        result: RallarRtcTopologyUpdateResult,
        repository: RtcTopologySnapshotRepository,
    ): Promise<RtcTopologySnapshotObservation> {
        this.validateTopology(result.snapshot);
        return await repository.observeSnapshot(result.snapshot);
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

    private requireConfigRepository(): void {
        if (!this.options.configRepository) {
            throw new Error('Group topology config repository is not configured');
        }
    }

    private async restoreConfig(
        groupRef: GroupRef,
        previous: StoredGroupTopologyConfig | undefined,
    ): Promise<void> {
        if (!previous) {
            await this.options.configRepository!.deleteConfig(groupRef);
            return;
        }

        await this.options.configRepository!.putConfig(previous);
    }

    private async restoreOverride(
        groupRef: GroupRef,
        previous: StoredGroupTopologyOverride | undefined,
    ): Promise<void> {
        if (!previous) {
            await this.options.configRepository!.deleteOverride(groupRef);
            return;
        }

        await this.options.configRepository!.putOverride(
            previous,
            previous.expiresAtEpochMs,
        );
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
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
