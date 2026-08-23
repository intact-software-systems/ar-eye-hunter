import type { WeightedGraph } from '@shared-graph/graph-props.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { RtcTopologyPlanner } from '../planning/rtc-topology-planner.ts';
import { RtcTopologyMetrics, type RallarRtcTopologyMetrics } from './rtc-topology-metrics.ts';
import {
    RtcTopologyRttRebuildScheduler,
    type RallarRtcTopologyRttQueueResult
} from './rtc-topology-rtt-rebuild-scheduler.ts';
import { RtcTopologySnapshotRegistry } from './rtc-topology-snapshot-registry.ts';

export interface RallarRtcTopologyServiceOptions {
    readonly topologyKind?: GroupTopologyKindSetting;
    readonly degreeLimit?: number;
    readonly rttReportingDegreeLimit?: number;
    readonly treeMinSize?: number;
    readonly meshMinSize?: number;
    readonly meshParamK?: number;
    readonly meshExitWidth?: number;
    readonly treeExitWidth?: number;
    readonly rttRebuildDebounceMs?: number;
    readonly now?: () => number;
}

export interface RallarRtcTopologyUpdateResult {
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly changed: boolean;
    readonly previous: RallarOverlayTopologySnapshot | null;
}

export interface RallarRtcTopologyUpdateOptions {
    readonly previous?: RallarOverlayTopologySnapshot;
    readonly topologyOptions?: RallarRtcTopologyServiceOptions;
    readonly planningIntent?: RtcTopologyPlanningIntent;
}

export type RtcTopologyPlanningIntent = 'membership-delta' | 'full-rebuild';

export interface RtcTopologyKindHysteresisWidths {
    readonly meshExitWidth: number;
    readonly treeExitWidth: number;
}

export { planRallarRtcTopologySnapshot } from '../planning/plan-rallar-rtc-topology-snapshot.ts';

export type { RallarRtcTopologyRttQueueResult } from './rtc-topology-rtt-rebuild-scheduler.ts';

const DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250;

export class RallarRtcTopologyService {
    private readonly metrics = new RtcTopologyMetrics();
    private readonly snapshots = new RtcTopologySnapshotRegistry();
    private readonly planner: RtcTopologyPlanner;
    private readonly rttRebuildScheduler: RtcTopologyRttRebuildScheduler;
    private readonly options: RallarRtcTopologyServiceOptions;

    constructor(options: RallarRtcTopologyServiceOptions = {}) {
        this.options = options;
        this.rttRebuildScheduler = new RtcTopologyRttRebuildScheduler({
            nowEpochMs: () => this.now(),
            debounceMs: options.rttRebuildDebounceMs ?? DEFAULT_RTT_REBUILD_DEBOUNCE_MS,
            metrics: this.metrics
        });
        this.planner = new RtcTopologyPlanner(options, {
            metrics: this.metrics,
            durationNowMs: () => this.durationNowMs()
        });
    }

    readMetrics(): RallarRtcTopologyMetrics {
        return this.metrics.read(this.snapshots.size, this.rttRebuildScheduler.size);
    }

    resetMetrics(): void {
        this.metrics.reset();
    }

    observeTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
        return this.snapshots.observe(snapshot);
    }

    recordTopologyPublishResult(changed: boolean): void {
        this.metrics.recordPublish(changed);
    }

    recordTopologyRebuildSkippedFingerprint(): void {
        this.metrics.recordFingerprintSkip();
    }

    updateGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {}
    ): RallarRtcTopologyUpdateResult {
        const result = this.planGroupTopology(group, rttMeasurements, options);
        this.observeCommittedTopologySnapshot(result.snapshot);
        return result;
    }

    observeCommittedTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
        const changed = this.observeTopologySnapshot(snapshot);
        this.rttRebuildScheduler.remove(snapshot.overlayId);
        return changed;
    }

    planGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {}
    ): RallarRtcTopologyUpdateResult {
        return this.planGroupTopologyAt(group, rttMeasurements, options, this.now());
    }

    planGroupTopologyAt(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        options: RallarRtcTopologyUpdateOptions,
        nowEpochMs: number
    ): RallarRtcTopologyUpdateResult {
        this.metrics.recordTopologyUpdateAttempt();
        const activePlanningInput = this.planner.createActivePlanningInput(group, rttMeasurements);
        const overlayId = toScopedOverlayId(group.group);
        const previous = options.previous?.overlayId === overlayId ? options.previous : this.snapshots.get(overlayId);
        return this.planner.planPrepared(
            {
                group,
                ...activePlanningInput,
                previous,
                updateOptions: options,
                nowEpochMs
            },
            this
        );
    }

    removeGroupTopology(group: GroupSnapshot): boolean {
        const overlayId = toScopedOverlayId(group.group);
        this.rttRebuildScheduler.remove(overlayId);
        const removed = this.snapshots.remove(overlayId);
        this.metrics.recordRemoval(removed);
        return removed;
    }

    readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
        return this.snapshots.get(toScopedOverlayId(group.group));
    }

    queueRttTopologyUpdate(group: GroupSnapshot): RallarRtcTopologyRttQueueResult {
        this.metrics.recordRttQueueRequest();
        const overlayId = toScopedOverlayId(group.group);
        return this.rttRebuildScheduler.queue({
            overlayId,
            hasSnapshot: this.snapshots.has(overlayId)
        });
    }

    flushDueRttTopologyUpdate(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {}
    ): RallarRtcTopologyUpdateResult | undefined {
        if (!this.claimDueRttTopologyUpdate(group.group)) {
            return undefined;
        }
        return this.updateGroupTopology(group, rttMeasurements, options);
    }

    claimDueRttTopologyUpdate(groupRef: GroupRef): boolean {
        this.metrics.recordRttFlushAttempt();
        return this.rttRebuildScheduler.claimDue(toScopedOverlayId(groupRef));
    }

    readRttTopologyUpdateDelayMs(group: GroupSnapshot): number | undefined {
        return this.rttRebuildScheduler.readDelayMs(toScopedOverlayId(group.group));
    }

    readRttRebuildDebounceMs(): number {
        return this.rttRebuildScheduler.readDebounceMs();
    }

    readNowEpochMs(): number {
        return this.now();
    }

    readRttReportingDegreeLimit(options: RallarRtcTopologyServiceOptions = this.options): number {
        return this.planner.readRttReportingDegreeLimit(options);
    }

    selectTopology(
        group: GroupSnapshot,
        options: RallarRtcTopologyServiceOptions = this.options,
        previousKind?: RallarRtcTopologyKind
    ): RallarRtcTopologyKind {
        return this.planner.selectTopology(group, options, previousKind);
    }

    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = []
    ): WeightedGraph {
        return this.planner.createRoomGraph(group, rttMeasurements, this);
    }

    readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths {
        return this.planner.readKindHysteresisWidths();
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private durationNowMs(): number {
        return globalThis.performance?.now() ?? Date.now();
    }
}
