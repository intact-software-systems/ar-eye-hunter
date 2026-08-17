import type { RtcTopologyMetrics } from './rtc-topology-metrics.ts';

export interface RallarRtcTopologyRttQueueResult {
  readonly overlayId: string;
  readonly dueAtEpochMs: number;
  readonly delayMs: number;
  readonly newlyQueued: boolean;
  readonly immediate: boolean;
}

export namespace RtcTopologyRttRebuildScheduler {
  export interface Dependencies {
    readonly nowEpochMs: () => number;
    readonly debounceMs: number;
    readonly metrics: RtcTopologyMetrics;
  }

  export interface QueueInput {
    readonly overlayId: string;
    readonly hasSnapshot: boolean;
  }
}

export class RtcTopologyRttRebuildScheduler {
  private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();
  private readonly dependencies: RtcTopologyRttRebuildScheduler.Dependencies;

  constructor(dependencies: RtcTopologyRttRebuildScheduler.Dependencies) {
    this.dependencies = dependencies;
  }

  queue(input: RtcTopologyRttRebuildScheduler.QueueInput): RallarRtcTopologyRttQueueResult {
    const nowEpochMs = this.dependencies.nowEpochMs();
    const existingDueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(input.overlayId);
    if (existingDueAtEpochMs !== undefined) {
      const immediate = existingDueAtEpochMs <= nowEpochMs;
      this.dependencies.metrics.recordRttQueueResult('coalesced', immediate);
      return {
        overlayId: input.overlayId,
        dueAtEpochMs: existingDueAtEpochMs,
        delayMs: Math.max(0, existingDueAtEpochMs - nowEpochMs),
        newlyQueued: false,
        immediate,
      };
    }
    const dueAtEpochMs = input.hasSnapshot ? nowEpochMs + this.readDebounceMs() : nowEpochMs;
    const immediate = dueAtEpochMs <= nowEpochMs;
    this.pendingRttUpdateDueAtByOverlayId.set(input.overlayId, dueAtEpochMs);
    this.dependencies.metrics.recordRttQueueResult('new', immediate);
    return {
      overlayId: input.overlayId,
      dueAtEpochMs,
      delayMs: Math.max(0, dueAtEpochMs - nowEpochMs),
      newlyQueued: true,
      immediate,
    };
  }

  claimDue(overlayId: string): boolean {
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);
    if (dueAtEpochMs === undefined || dueAtEpochMs > this.dependencies.nowEpochMs()) {
      this.dependencies.metrics.recordRttFlushResult(false);
      return false;
    }
    this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
    this.dependencies.metrics.recordRttFlushResult(true);
    return true;
  }

  readDelayMs(overlayId: string): number | undefined {
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);
    return dueAtEpochMs === undefined
      ? undefined
      : Math.max(0, dueAtEpochMs - this.dependencies.nowEpochMs());
  }

  remove(overlayId: string): boolean {
    return this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
  }

  readDebounceMs(): number {
    return Math.max(0, this.dependencies.debounceMs);
  }

  get size(): number {
    return this.pendingRttUpdateDueAtByOverlayId.size;
  }
}
