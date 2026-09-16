import type { RallarBlackBoxTestRtcStreamThresholds } from './rallar-black-box-test-contracts.ts';

export const DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES = [
    'minSendSuccessRatio',
    'maxDroppedFrames',
    'maxBackpressureCount',
    'maxP95SendDurationMs',
    'maxP99SendDurationMs',
    'maxAverageStartDriftMs',
    'maxStartDriftMs',
    'maxJitterMs'
] as const satisfies readonly (keyof RallarBlackBoxTestRtcStreamThresholds)[];

export type DistributedRunTuningKnobName =
    | 'ackTimeoutMs'
    | 'barrier.timeoutMs'
    | 'durationMs'
    | 'intervalMs'
    | 'rateHz'
    | 'maxInFlight'
    | `thresholds.${typeof DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES[number]}`;

export interface DistributedRunTuningKnobConstraint {
    readonly type: 'integer' | 'number';
    /** Absent when the knob has no inclusive lower bound. */
    readonly minimum?: number;
    /** Absent when the knob has no exclusive lower bound. */
    readonly exclusiveMinimum?: number;
    /** Absent when the knob has no upper bound. */
    readonly maximum?: number;
}

/** One flat row per knob: Tune reads manifest and command knobs uniformly, so command identity is optional. */
export interface DistributedRunTuningKnob {
    readonly name: DistributedRunTuningKnobName;
    readonly pointer: string;
    readonly scope: 'manifest' | 'command' | 'stream-threshold';
    /** Absent when the manifest leaves the setting unset. */
    readonly currentValue?: number;
    readonly availability: 'configured' | 'unset' | 'blocked';
    readonly effective: boolean;
    readonly constraint: DistributedRunTuningKnobConstraint;
    /** Absent for manifest-scope knobs. */
    readonly recipeIndex?: number;
    /** Absent for manifest-scope knobs and for a recipe selection that names no recipe id. */
    readonly recipeId?: string;
    /** Absent for manifest-scope knobs and for a command that names no commandId. */
    readonly commandId?: string;
    /** Absent for manifest-scope knobs. */
    readonly commandKind?: 'loop' | 'rtc.stream';
    /** Absent when nothing qualifies the knob's availability. */
    readonly reason?: string;
}

export interface DistributedRunTuningInventoryLimitation {
    readonly code:
        | 'reference-only-recipe'
        | 'command-limit-exceeded'
        | 'malformed-command'
        | 'depth-limit-exceeded';
    readonly message: string;
    readonly recipeIndex: number;
    /** Absent when the limitation precedes reading the recipe selection or the selection names no recipe id. */
    readonly recipeId?: string;
}

export interface DistributedRunTuningInventory {
    readonly knobs: readonly DistributedRunTuningKnob[];
    readonly limitations: readonly DistributedRunTuningInventoryLimitation[];
}
