import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    EffectiveGroupTopologyConfig,
    ReconfigureGroupTopologyResponse
} from '@shared/api/graph-topology-management-types.ts';
import { readGroupCreatedByPrincipalId, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { filterRtcRttMeasurementsForGroup } from '../../rtc-rtt/policy/rtc-rtt-measurement-policy.ts';
import type { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyServerOptions } from '../config/group-topology-config.ts';
import { GroupTopologyValidationError } from '../group-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../replay/consumer/rtc-topology-replay-policy.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult,
    type RtcTopologyPlanningIntent
} from '../runtime/rallar-rtc-topology-service.ts';
import type {
    GroupTopologyPlanningAuthority,
    ReadGroupTopologyPlanningAuthorityInput
} from './group-topology-planning-authority.ts';
import type {
    GroupTopologyGroupSnapshotReader,
    GroupTopologyPublisher,
    ReconcileGroupTopologyResult,
    ReconfigureGroupTopologyInput
} from './group-topology-planning-contracts.ts';
import { materializeRtcOverlayTopologyBroadcastMessage } from './materialize-rtc-overlay-topology-broadcast-message.ts';
import {
    resolveTopologyPlanAction,
    type GroupTopologyReplanningRead,
    type TopologyWorkOrigin
} from './resolve-topology-plan-action.ts';
import {
    isGroupTopologyActiveAt,
    selectGroupTopologyPlanningSnapshot
} from './select-group-topology-planning-snapshot.ts';

export interface GroupTopologyPlanningServiceDependencies {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly queryService: Pick<GroupTopologyConfigQueryService, 'readConfig' | 'readResolvedTopologyConfig'>;
    readonly topologyService: RallarRtcTopologyService;
    readonly readCurrentGroupSnapshot: (
        groupRef: GroupRef,
        knownGroup: GroupSnapshot | undefined
    ) => Promise<GroupSnapshot | undefined>;
    readonly readRttMeasurements: (
        group: GroupSnapshot
    ) => readonly RttMeasurementInfo[] | Promise<readonly RttMeasurementInfo[]>;
    readonly topologyMode: 'local' | 'persistent';
    /**
     * The group's stored replanning mode, for the stage-keyed planning gate
     * (plan slice 4b). Absent means no policy store exists in this
     * composition; the default preset's mode then governs.
     */
    readonly readTopologyReplanningMode?: (
        group: GroupSnapshot
    ) => GroupTopologyReplanningRead | Promise<GroupTopologyReplanningRead>;
    readonly publisher?: GroupTopologyPublisher;
    readonly serverDefaults?: GroupTopologyServerOptions;
}

export interface TopologyPlanningRequest {
    readonly intent: RtcTopologyPlanningIntent;
    readonly origin: TopologyWorkOrigin;
}

export class GroupTopologyPlanningService {
    private readonly dependencies: GroupTopologyPlanningServiceDependencies;

    constructor(dependencies: GroupTopologyPlanningServiceDependencies) {
        this.dependencies = dependencies;
    }

    recordTopologyPublication(published: boolean): void {
        this.dependencies.topologyService.recordTopologyPublishResult(published);
    }

    recordTopologyRebuildSkippedFingerprint(): void {
        this.dependencies.topologyService.recordTopologyRebuildSkippedFingerprint();
    }

    async readTopologyPlanningAuthority(
        input: ReadGroupTopologyPlanningAuthorityInput
    ): Promise<GroupTopologyPlanningAuthority> {
        const currentGroup = await this.dependencies.readCurrentGroupSnapshot(
            input.groupRef,
            input.knownGroup
        );
        const group = input.knownGroup
            ? selectGroupTopologyPlanningSnapshot(input.knownGroup, currentGroup, input.snapshotSelection)
            : requireGroupTopologyPlanningSnapshot(input.groupRef, currentGroup);
        const [config, rttMeasurements, replanning] = await Promise.all([
            this.dependencies.queryService.readResolvedTopologyConfig(group.group, input.requestOptions),
            this.readRawRttMeasurements(group),
            this.readTopologyReplanningMode(group)
        ]);
        return {
            group,
            config,
            kindHysteresisWidths: this.dependencies.topologyService.readKindHysteresisWidths(),
            rttMeasurements,
            replanning,
            nowEpochMs: this.dependencies.topologyService.readNowEpochMs()
        };
    }

    computeTopologyFromAuthority(
        authority: GroupTopologyPlanningAuthority,
        previous: RallarOverlayTopologySnapshot | undefined,
        planning: TopologyPlanningRequest = { intent: 'full-rebuild', origin: 'automatic' }
    ): ReconcileGroupTopologyResult {
        if (!isGroupTopologyActiveAt(authority.group, authority.nowEpochMs)) {
            return removedTopologyResult(authority.group, previous);
        }
        const action = resolveTopologyPlanAction({
            lifecycleState: authority.group.group.lifecycleState,
            replanning: authority.replanning,
            workOrigin: planning.origin,
            previous
        });
        if (action === 'publish-removal') {
            return removedTopologyResult(authority.group, previous);
        }
        if (action === 'freeze') {
            return { action: 'frozen', current: requireFrozenTopology(previous) };
        }
        const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
            authority.group,
            authority.rttMeasurements,
            authority.config.effective,
            previous
        );
        const result = this.dependencies.topologyService.planGroupTopologyAt(
            authority.group,
            filteredRttMeasurements,
            { previous, topologyOptions: authority.config.effective, planningIntent: planning.intent },
            authority.nowEpochMs
        );
        this.validateTopology(result.snapshot);
        return { action: 'planned', ...result };
    }

    async computeGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined
    ): Promise<ReconcileGroupTopologyResult> {
        const authority = await this.readTopologyPlanningAuthority({
            groupRef: group.group,
            knownGroup: group,
            snapshotSelection: 'prefer-current'
        });
        return this.computeTopologyFromAuthority(authority, previous);
    }

    async reconfigureGroupTopology(
        input: ReconfigureGroupTopologyInput
    ): Promise<ReconfigureGroupTopologyResponse> {
        this.requireLocalTopology('Topology reconfiguration requires AppInbox execution');
        const group = await this.readReconfigureGroup(input);
        const config = await this.dependencies.queryService.readResolvedTopologyConfig(
            input.groupRef,
            input.requestOptions
        );
        const previous = this.dependencies.topologyService.readSnapshot(group);
        if (await this.isTopologyPlanFrozen(group, previous, 'commanded')) {
            return toReconfigureGroupTopologyResponse({
                groupRef: input.groupRef,
                result: { snapshot: requireFrozenTopology(previous), previous: previous ?? null, changed: false },
                config,
                published: false
            });
        }
        const result = this.dependencies.topologyService.updateGroupTopology(
            group,
            this.filterRttMeasurementsForGroup(
                group,
                await this.readRawRttMeasurements(group),
                config.effective,
                previous
            ),
            { previous, topologyOptions: config.effective }
        );
        this.validateTopology(result.snapshot);
        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true
        );
        return toReconfigureGroupTopologyResponse({
            groupRef: input.groupRef,
            result,
            config,
            published
        });
    }

    async reconcileGroupTopology(group: GroupSnapshot): Promise<ReconcileGroupTopologyResult> {
        if (this.dependencies.topologyMode === 'persistent') {
            throw new TypeError('Persistent topology reconciliation requires APP_OUTBOX');
        }
        const previous = this.dependencies.topologyService.readSnapshot(group);
        const result = await this.computeGroupTopology(group, previous);
        if (result.action === 'frozen') {
            return result;
        }
        this.observeCommittedTopology(group, result.snapshot);
        return result;
    }

    observeCommittedTopology(group: GroupSnapshot, snapshot: RallarOverlayTopologySnapshot): void {
        if (snapshot.state === 'removed') {
            this.dependencies.topologyService.removeGroupTopology(group);
            return;
        }
        this.dependencies.topologyService.observeCommittedTopologySnapshot(snapshot);
    }

    async flushDueGroupTopology(
        input: ReconfigureGroupTopologyInput
    ): Promise<ReconfigureGroupTopologyResponse | undefined> {
        if (this.dependencies.topologyMode === 'persistent') {
            return undefined;
        }
        const group = await this.readReconfigureGroup(input);
        const config = await this.dependencies.queryService.readConfig(input.groupRef);
        const previous = this.dependencies.topologyService.readSnapshot(group);
        if (await this.isTopologyPlanFrozen(group, previous, 'automatic')) {
            return undefined;
        }
        const result = this.dependencies.topologyService.flushDueRttTopologyUpdate(
            group,
            this.filterRttMeasurementsForGroup(
                group,
                await this.readRawRttMeasurements(group),
                config.effective,
                previous
            ),
            { previous, topologyOptions: config.effective }
        );
        if (!result) {
            return undefined;
        }
        this.validateTopology(result.snapshot);
        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true
        );
        return toReconfigureGroupTopologyResponse({
            groupRef: input.groupRef,
            result,
            config,
            published
        });
    }

    removeGroupTopology(group: GroupSnapshot): Promise<void> {
        if (this.dependencies.topologyMode === 'local') {
            this.dependencies.topologyService.removeGroupTopology(group);
        }
        return Promise.resolve();
    }

    /**
     * Only the `follow-replanning-policy` row consults the mode, so only an
     * `active` group pays the stored-policy read; every other stage carries
     * the default preset's mode, which its disposition row never reads.
     */
    private async readTopologyReplanningMode(group: GroupSnapshot): Promise<GroupTopologyReplanningRead> {
        if (group.group.lifecycleState !== 'active' || !this.dependencies.readTopologyReplanningMode) {
            return createDefaultGroupLifecyclePolicy().topology.replanning;
        }
        return await this.dependencies.readTopologyReplanningMode(group);
    }

    /**
     * The local paths' share of the 4b gate: freeze replacement of an active
     * stored layout when the stage or the commanded mode says so. The removal
     * disposition stays with the reconcile path — local mode's explicit
     * reconfigure keeps today's behavior for stages that publish removal.
     */
    private async isTopologyPlanFrozen(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
        workOrigin: TopologyWorkOrigin
    ): Promise<boolean> {
        if (previous?.state !== 'active') {
            return false;
        }
        const replanning = await this.readTopologyReplanningMode(group);
        return resolveTopologyPlanAction({
            lifecycleState: group.group.lifecycleState,
            replanning,
            workOrigin,
            previous
        }) === 'freeze';
    }

    private async readReconfigureGroup(input: ReconfigureGroupTopologyInput): Promise<GroupSnapshot> {
        const group = input.groupSnapshot ?? (await this.dependencies.findGroupSnapshotByRef(input.groupRef));
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
        }
        return group;
    }

    private async readRawRttMeasurements(
        group: GroupSnapshot
    ): Promise<readonly RttMeasurementInfo[]> {
        return await this.dependencies.readRttMeasurements(group);
    }

    private filterRttMeasurementsForGroup(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        topologyOptions: EffectiveGroupTopologyConfig,
        overlaySnapshot: RallarOverlayTopologySnapshot | undefined
    ): readonly RttMeasurementInfo[] {
        if (rttMeasurements.length === 0) {
            return rttMeasurements;
        }
        return filterRtcRttMeasurementsForGroup({
            group,
            rttMeasurements,
            overlaySnapshot,
            degreeLimit: this.dependencies.topologyService.readRttReportingDegreeLimit({
                ...topologyOptions,
                rttReportingDegreeLimit: this.dependencies.serverDefaults?.rttReportingDegreeLimit
            })
        });
    }

    private validateTopology(snapshot: RallarOverlayTopologySnapshot): void {
        if (snapshot.state === 'removed') {
            return;
        }
        const result = validateGroupTopologyNextHops({
            activeSessionIds: new Set(snapshot.activeSessionIds),
            nextHopsBySessionId: snapshot.nextHopsBySessionId,
            maxDegree: snapshot.degreeLimit
        });
        if (!result.valid) {
            throw new GroupTopologyValidationError(
                result.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.sessionId ? ['nextHopsBySessionId', issue.sessionId] : undefined,
                    message: issue.code,
                    details: issue
                }))
            );
        }
    }

    private async publishIfRequested(
        group: GroupSnapshot,
        result: RallarRtcTopologyUpdateResult,
        publisher: GroupTopologyPublisher | undefined,
        publish: boolean
    ): Promise<boolean> {
        if (!publish) {
            return false;
        }
        const resolvedPublisher = publisher ?? this.dependencies.publisher;
        if (!resolvedPublisher) {
            this.recordTopologyPublication(false);
            return false;
        }
        const createdAtEpochMs = this.dependencies.topologyService.readNowEpochMs();
        const deliveredCount = await resolvedPublisher(
            materializeRtcOverlayTopologyBroadcastMessage(group, result.snapshot, {
                workId: crypto.randomUUID(),
                createdAtEpochMs,
                expiresAtEpochMs: createdAtEpochMs + RTC_TOPOLOGY_REPLAY_RETENTION_MS
            }),
            result.snapshot
        );
        const published = deliveredCount > 0;
        this.recordTopologyPublication(published);
        return published;
    }

    private requireLocalTopology(message: string): void {
        if (this.dependencies.topologyMode === 'persistent') {
            throw new TypeError(message);
        }
    }
}

function requireGroupTopologyPlanningSnapshot(
    groupRef: GroupRef,
    snapshot: GroupSnapshot | undefined
): GroupSnapshot {
    if (!snapshot) {
        throw new Error(`Group snapshot not found: ${groupRef.groupId}`);
    }
    return snapshot;
}

function requireFrozenTopology(
    previous: RallarOverlayTopologySnapshot | undefined
): RallarOverlayTopologySnapshot {
    if (!previous) {
        throw new TypeError('A frozen topology plan requires a stored layout');
    }
    return previous;
}

function removedTopologyResult(
    group: GroupSnapshot,
    previous: RallarOverlayTopologySnapshot | undefined
): ReconcileGroupTopologyResult {
    const activeSessionIds = [
        ...new Set([...(previous?.activeSessionIds ?? []), ...readGroupMemberSessionIds(group)])
    ].sort(compareRtcTopologyIdentifiers);
    return {
        action: 'planned',
        snapshot: {
            sourceGroupStateCausalRevision: group.causalRevision,
            state: 'removed',
            overlayId: toScopedOverlayId(group.group),
            groupRef: canonicalGroupRef(group.group),
            name: previous?.name ?? group.group.displayName,
            topology: previous?.topology ?? 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((sessionId) => [sessionId, []])),
            degreeLimit: previous?.degreeLimit ?? 1,
            version: previous?.version ?? 0,
            createdByClientId: previous?.createdByClientId ?? readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ?? group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs
        },
        previous: previous ?? null,
        changed: previous?.state !== 'removed'
    };
}

interface ReconfigureGroupTopologyResponseInput {
    readonly groupRef: GroupRef;
    readonly result: RallarRtcTopologyUpdateResult;
    readonly config: Awaited<ReturnType<GroupTopologyConfigQueryService['readConfig']>>;
    readonly published: boolean;
}

function toReconfigureGroupTopologyResponse(
    input: ReconfigureGroupTopologyResponseInput
): ReconfigureGroupTopologyResponse {
    return {
        groupRef: input.groupRef,
        overlayId: input.result.snapshot.overlayId,
        changed: input.result.changed,
        snapshot: input.result.snapshot,
        previous: input.result.previous,
        config: input.config,
        published: input.published
    };
}

function canonicalGroupRef(groupRef: GroupRef): GroupRef {
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}
