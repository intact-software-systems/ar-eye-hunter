import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
  compareOverlayTopologyCausalTuple,
  type RallarOverlayTopologySnapshot,
  type RallarRtcTopologyKind,
} from '@shared/api/overlay-topology.ts';
import type { WeightedGraph } from '@shared-graph/graph-props.ts';

import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
  RtcTopologyMetrics,
  type RallarRtcTopologyMetrics,
} from '../topology/rallar-rtc-topology-metrics.ts';
import { RtcTopologyPlanner } from '../topology/planning/rtc-topology-planner.ts';

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

// prettier-ignore
export {
  planRallarRtcTopologySnapshot,
} from '../topology/planning/plan-rallar-rtc-topology-snapshot.ts';

export interface RallarRtcTopologyRttQueueResult {
  readonly overlayId: string;
  readonly dueAtEpochMs: number;
  readonly delayMs: number;
  readonly newlyQueued: boolean;
  readonly immediate: boolean;
}

const DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250;

export class RallarRtcTopologyService {
  private readonly snapshotsByOverlayId = new Map<string, RallarOverlayTopologySnapshot>();
  private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();
  private readonly metrics = new RtcTopologyMetrics();
  private readonly planner: RtcTopologyPlanner;
  private readonly options: RallarRtcTopologyServiceOptions;

  constructor(options: RallarRtcTopologyServiceOptions = {}) {
    this.options = options;
    this.planner = new RtcTopologyPlanner(options, {
      metrics: this.metrics,
      durationNowMs: () => this.durationNowMs(),
    });
  }

  readMetrics(): RallarRtcTopologyMetrics {
    return this.metrics.read(
      this.snapshotsByOverlayId.size,
      this.pendingRttUpdateDueAtByOverlayId.size,
    );
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  observeTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
    const current = this.snapshotsByOverlayId.get(snapshot.overlayId);
    const comparison = current ? compareOverlayTopologyCausalTuple(snapshot, current) : null;
    if (!current || comparison === 'dominates') {
      this.snapshotsByOverlayId.set(snapshot.overlayId, snapshot);
      return true;
    }
    if (comparison === 'equal' && !rtcTopologySemanticEqual(snapshot, current)) {
      throw new Error(`RTC topology process-cache revision conflict: ${snapshot.overlayId}`);
    }
    if (comparison === 'incomparable') {
      throw new Error(`RTC topology process-cache causal conflict: ${snapshot.overlayId}`);
    }
    return false;
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
    options: RallarRtcTopologyUpdateOptions = {},
  ): RallarRtcTopologyUpdateResult {
    const result = this.planGroupTopology(group, rttMeasurements, options);
    this.observeCommittedTopologySnapshot(result.snapshot);
    return result;
  }

  observeCommittedTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
    const changed = this.observeTopologySnapshot(snapshot);
    this.pendingRttUpdateDueAtByOverlayId.delete(snapshot.overlayId);
    return changed;
  }

  planGroupTopology(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[] = [],
    options: RallarRtcTopologyUpdateOptions = {},
  ): RallarRtcTopologyUpdateResult {
    return this.planGroupTopologyAt(group, rttMeasurements, options, this.now());
  }

  planGroupTopologyAt(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[],
    options: RallarRtcTopologyUpdateOptions,
    nowEpochMs: number,
  ): RallarRtcTopologyUpdateResult {
    const overlayId = toScopedOverlayId(group.group);
    const previous =
      options.previous?.overlayId === overlayId
        ? options.previous
        : this.snapshotsByOverlayId.get(overlayId);
    return this.planner.plan({
      group,
      rttMeasurements,
      previous,
      updateOptions: options,
      nowEpochMs,
    });
  }

  removeGroupTopology(group: GroupSnapshot): boolean {
    const overlayId = toScopedOverlayId(group.group);
    this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
    const removed = this.snapshotsByOverlayId.delete(overlayId);
    this.metrics.recordRemoval(removed);
    return removed;
  }

  readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
    return this.snapshotsByOverlayId.get(toScopedOverlayId(group.group));
  }

  queueRttTopologyUpdate(group: GroupSnapshot): RallarRtcTopologyRttQueueResult {
    this.metrics.recordRttQueueRequest();
    const overlayId = toScopedOverlayId(group.group);
    const now = this.now();
    const existingDueAt = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);
    if (existingDueAt !== undefined) {
      this.metrics.recordRttQueueResult('coalesced', existingDueAt <= now);
      return {
        overlayId,
        dueAtEpochMs: existingDueAt,
        delayMs: Math.max(0, existingDueAt - now),
        newlyQueued: false,
        immediate: existingDueAt <= now,
      };
    }
    const dueAtEpochMs = this.snapshotsByOverlayId.has(overlayId)
      ? now + this.rttRebuildDebounceMs()
      : now;
    this.pendingRttUpdateDueAtByOverlayId.set(overlayId, dueAtEpochMs);
    this.metrics.recordRttQueueResult('new', dueAtEpochMs <= now);
    return {
      overlayId,
      dueAtEpochMs,
      delayMs: Math.max(0, dueAtEpochMs - now),
      newlyQueued: true,
      immediate: dueAtEpochMs <= now,
    };
  }

  flushDueRttTopologyUpdate(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[] = [],
    options: RallarRtcTopologyUpdateOptions = {},
  ): RallarRtcTopologyUpdateResult | undefined {
    if (!this.claimDueRttTopologyUpdate(group.group)) {
      return undefined;
    }
    return this.updateGroupTopology(group, rttMeasurements, options);
  }

  claimDueRttTopologyUpdate(groupRef: GroupRef): boolean {
    this.metrics.recordRttFlushAttempt();
    const overlayId = toScopedOverlayId(groupRef);
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);
    if (dueAtEpochMs === undefined || dueAtEpochMs > this.now()) {
      this.metrics.recordRttFlushResult(false);
      return false;
    }
    this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
    this.metrics.recordRttFlushResult(true);
    return true;
  }

  readRttTopologyUpdateDelayMs(group: GroupSnapshot): number | undefined {
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(toScopedOverlayId(group.group));
    return dueAtEpochMs === undefined ? undefined : Math.max(0, dueAtEpochMs - this.now());
  }

  readRttRebuildDebounceMs(): number {
    return this.rttRebuildDebounceMs();
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
    previousKind?: RallarRtcTopologyKind,
  ): RallarRtcTopologyKind {
    return this.planner.selectTopology(group, options, previousKind);
  }

  createRoomGraph(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[] = [],
  ): WeightedGraph {
    return this.planner.createRoomGraph(group, rttMeasurements);
  }

  readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths {
    return this.planner.readKindHysteresisWidths();
  }

  private rttRebuildDebounceMs(): number {
    return Math.max(0, this.options.rttRebuildDebounceMs ?? DEFAULT_RTT_REBUILD_DEBOUNCE_MS);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private durationNowMs(): number {
    return globalThis.performance?.now() ?? Date.now();
  }
}
