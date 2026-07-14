import type { RallarBlackBoxTestRtcStreamThresholds } from './types.ts';

export const DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES = [
    'minSendSuccessRatio',
    'maxDroppedFrames',
    'maxBackpressureCount',
    'maxP95SendDurationMs',
    'maxP99SendDurationMs',
    'maxAverageStartDriftMs',
    'maxStartDriftMs',
    'maxJitterMs',
] as const satisfies readonly (keyof RallarBlackBoxTestRtcStreamThresholds)[];

export type DistributedRunTuningKnobName =
    | 'ackTimeoutMs'
    | 'barrier.timeoutMs'
    | 'durationMs'
    | 'intervalMs'
    | 'rateHz'
    | 'maxInFlight'
    | `thresholds.${typeof DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES[number]}`;

export type DistributedRunTuningKnobConstraint = Readonly<{
    type: 'integer' | 'number';
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
}>;

export type DistributedRunTuningKnob = Readonly<{
    name: DistributedRunTuningKnobName;
    pointer: string;
    scope: 'manifest' | 'command' | 'stream-threshold';
    currentValue?: number;
    availability: 'configured' | 'unset' | 'blocked';
    effective: boolean;
    constraint: DistributedRunTuningKnobConstraint;
    recipeIndex?: number;
    recipeId?: string;
    commandId?: string;
    commandKind?: 'loop' | 'rtc.stream';
    reason?: string;
}>;

export type DistributedRunTuningInventoryLimitation = Readonly<{
    code:
        | 'reference-only-recipe'
        | 'command-limit-exceeded'
        | 'malformed-command'
        | 'depth-limit-exceeded';
    message: string;
    recipeIndex?: number;
    recipeId?: string;
}>;

export type DistributedRunTuningInventory = Readonly<{
    knobs: readonly DistributedRunTuningKnob[];
    limitations: readonly DistributedRunTuningInventoryLimitation[];
}>;
