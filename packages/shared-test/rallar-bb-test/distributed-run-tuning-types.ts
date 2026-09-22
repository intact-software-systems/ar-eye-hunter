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

export type DistributedRunManifestTuningKnobName = 'ackTimeoutMs' | 'barrier.timeoutMs';

export type DistributedRunCommandTuningKnobName =
    | 'durationMs'
    | 'intervalMs'
    | 'rateHz'
    | 'maxInFlight'
    | `thresholds.${typeof DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES[number]}`;

export type DistributedRunTuningKnobName = DistributedRunManifestTuningKnobName | DistributedRunCommandTuningKnobName;

export interface DistributedRunTuningKnobConstraint {
    readonly type: 'integer' | 'number';
    /** Absent when the knob has no inclusive lower bound. */
    readonly minimum?: number;
    /** Absent when the knob has no exclusive lower bound. */
    readonly exclusiveMinimum?: number;
    /** Absent when the knob has no upper bound. */
    readonly maximum?: number;
}

export type DistributedRunTuningKnob = DistributedRunManifestTuningKnob | DistributedRunCommandTuningKnob;

export interface DistributedRunManifestTuningKnob extends DistributedRunTuningKnobFields {
    readonly scope: 'manifest';
    readonly name: DistributedRunManifestTuningKnobName;
}

export interface DistributedRunCommandTuningKnob extends DistributedRunTuningKnobFields {
    readonly scope: 'command' | 'stream-threshold';
    readonly name: DistributedRunCommandTuningKnobName;
    readonly recipeIndex: number;
    readonly recipeId: string;
    /** Absent when the command names no commandId. */
    readonly commandId?: string;
    readonly commandKind: 'loop' | 'rtc.stream';
}

export interface DistributedRunTuningInventoryLimitation {
    readonly code:
        | 'reference-only-recipe'
        | 'command-limit-exceeded'
        | 'depth-limit-exceeded';
    readonly message: string;
    readonly recipeIndex: number;
    /** Absent when the limitation precedes reading the recipe selection. */
    readonly recipeId?: string;
}

export interface DistributedRunTuningInventory {
    readonly knobs: readonly DistributedRunTuningKnob[];
    readonly limitations: readonly DistributedRunTuningInventoryLimitation[];
}

interface DistributedRunTuningKnobFields {
    readonly pointer: string;
    /** Absent when the manifest or command leaves the setting unset. */
    readonly currentValue?: number;
    readonly availability: 'configured' | 'unset' | 'blocked';
    readonly effective: boolean;
    readonly constraint: DistributedRunTuningKnobConstraint;
    /** Absent when nothing qualifies the knob's availability. */
    readonly reason?: string;
}
