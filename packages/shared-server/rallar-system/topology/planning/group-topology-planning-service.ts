import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
    EffectiveGroupTopologyConfig,
    ReconfigureGroupTopologyResponse
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';

import { filterRtcRttMeasurementsForGroup } from '../../rtc-rtt/policy/rtc-rtt-measurement-policy.ts';
import type { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyServerOptions } from '../config/group-topology-config.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../replay/consumer/rtc-topology-replay-policy.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult
} from '../runtime/rallar-rtc-topology-service.ts';
import {
    computeGroupTopologyFromAuthority,
    requireFrozenTopology,
    validateComputedGroupTopology,
    type TopologyPlanningRequest
} from './compute-group-topology-from-authority.ts';
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
    consultsReplanningPolicy,
    resolveTopologyPlanAction,
    toGroupTopologyReplanningRead,
    type GroupTopologyReplanningRead,
    type TopologyPlanAction,
    type TopologyWorkOrigin
} from './resolve-topology-plan-action.ts';
import { selectGroupTopologyPlanningSnapshot } from './select-group-topology-planning-snapshot.ts';

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
     * The stored lifecycle-policy read, for the stage-keyed planning gate
     * (plan slice 4b) — the same port every other topology consumer takes.
     * Absent means no policy store exists in this composition; the default
     * preset's mode then governs (`toGroupTopologyReplanningRead` owns that
     * fold).
     */
    readonly readLifecyclePolicy?: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    readonly publisher?: GroupTopologyPublisher;
    readonly serverDefaults?: GroupTopologyServerOptions;
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

    recordTopologyPlanFrozen(): void {
        this.dependencies.topologyService.recordTopologyPlanFrozen();
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
            rttReportingDegreeLimit: this.dependencies.topologyService.readRttReportingDegreeLimit({
                ...config.effective,
                rttReportingDegreeLimit: this.dependencies.serverDefaults?.rttReportingDegreeLimit
            }),
            rttMeasurements,
            replanning,
            nowEpochMs: this.dependencies.topologyService.readNowEpochMs()
        };
    }

    computeTopologyFromAuthority(
        authority: GroupTopologyPlanningAuthority,
        previous: RallarOverlayTopologySnapshot | undefined,
        planning: TopologyPlanningRequest
    ): ReconcileGroupTopologyResult {
        return computeGroupTopologyFromAuthority(authority, previous, planning);
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
        // The machinery's own reconcile sweep: automatic by definition.
        const computed = this.computeTopologyFromAuthority(authority, previous, {
            intent: 'full-rebuild',
            origin: 'automatic'
        });
        validateComputedGroupTopology(computed);
        return computed;
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
        // Only freeze gates the explicit reconfigure; a removal-disposition
        // stage keeps today's local planning (a skip has no snapshot to
        // answer with — recorded residue, api-v1 converges on the handler).
        if (await this.readLocalTopologyPlanAction(group, previous, 'commanded') === 'freeze') {
            this.dependencies.topologyService.recordTopologyPlanFrozen();
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
        validateComputedGroupTopology({ ...result, action: 'planned' });
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
        // The automatic flush writes only when the stage says plan: freeze
        // holds the candidate and a removal-disposition stage has nothing
        // for an RTT refresh to improve.
        if (await this.readLocalTopologyPlanAction(group, previous, 'automatic') !== 'plan') {
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
        validateComputedGroupTopology({ ...result, action: 'planned' });
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
     * Only stages whose disposition is `follow-replanning-policy` consult
     * the mode (the gate is spelled off the registry so the two cannot
     * drift); every other stage carries the default preset's mode, which
     * its disposition row never reads.
     */
    private async readTopologyReplanningMode(group: GroupSnapshot): Promise<GroupTopologyReplanningRead> {
        const readLifecyclePolicy = this.dependencies.readLifecyclePolicy;
        if (!readLifecyclePolicy || !consultsReplanningPolicy(group.group.lifecycleState)) {
            return toGroupTopologyReplanningRead({ status: 'absent' });
        }
        return toGroupTopologyReplanningRead(await readLifecyclePolicy(group.group));
    }

    /** The local paths' share of the 4b gate, resolved by the one owner. */
    private async readLocalTopologyPlanAction(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined,
        workOrigin: TopologyWorkOrigin
    ): Promise<TopologyPlanAction> {
        return resolveTopologyPlanAction({
            lifecycleState: group.group.lifecycleState,
            replanning: await this.readTopologyReplanningMode(group),
            workOrigin,
            previous
        });
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
