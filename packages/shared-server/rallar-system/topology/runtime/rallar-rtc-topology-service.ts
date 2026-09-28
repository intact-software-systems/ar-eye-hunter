import type { WeightedGraph } from '@shared-graph/graph-props.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { RtcTopologyPlanner } from '../planning/rtc-topology-planner.ts';
import {
    RtcTopologyMetrics,
    type RallarRtcTopologyMetrics,
    type RtcTopologyPlanningObservation
} from './rtc-topology-metrics.ts';
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
    readonly now?: () => number;
    readonly durationNowMs?: () => number;
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

export class RallarRtcTopologyService {
    private readonly metrics = new RtcTopologyMetrics();
    private readonly snapshots = new RtcTopologySnapshotRegistry();
    private readonly planner: RtcTopologyPlanner;
    private readonly options: RallarRtcTopologyServiceOptions;

    constructor(options: RallarRtcTopologyServiceOptions = {}) {
        this.options = options;
        this.planner = new RtcTopologyPlanner(options, {
            metrics: this.metrics,
            durationNowMs: () => this.durationNowMs()
        });
    }

    readMetrics(): RallarRtcTopologyMetrics {
        return this.metrics.read(this.snapshots.size);
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

    recordTopologyPlanningObservation(
        observation: RtcTopologyPlanningObservation,
        topologyWorkComputeDurationMs: number
    ): void {
        this.metrics.recordPlanningObservation(observation, topologyWorkComputeDurationMs);
    }

    recordTopologyRebuildSkippedFingerprint(): void {
        this.metrics.recordFingerprintSkip();
    }

    /** A stage or policy hold refused a replacement (4b) — not a publish attempt. */
    recordTopologyPlanFrozen(): void {
        this.metrics.recordPlanFrozen();
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
        return this.observeTopologySnapshot(snapshot);
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
        return this.planner.planCanonical(
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
        const removed = this.snapshots.remove(toScopedOverlayId(group.group));
        this.metrics.recordRemoval(removed);
        return removed;
    }

    readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
        return this.snapshots.get(toScopedOverlayId(group.group));
    }

    readNowEpochMs(): number {
        return this.now();
    }

    readDurationNowMs(): number {
        return this.durationNowMs();
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
        return this.options.durationNowMs?.() ?? globalThis.performance?.now() ?? Date.now();
    }
}
