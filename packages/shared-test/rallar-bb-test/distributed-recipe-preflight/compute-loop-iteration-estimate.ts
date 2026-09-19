import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand
} from '../rallar-black-box-test-contracts.ts';
import { decodeNonNegativeInteger, decodePositiveInteger } from '../runtime/decode-runtime-result-values.ts';

export type LoopIterationEstimate = Readonly<{
    estimatedIterations: number;
    durationMs?: number;
    intervalMs?: number;
    warnings: readonly string[];
    limitErrors: readonly string[];
}>;

/**
 * Preflight estimate only. A duration-based loop finishes on runtime latency, so this
 * deliberately differs from the count-based preview arithmetic.
 */
export function computeLoopIterationEstimate(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'loop'; }>
): LoopIterationEstimate {
    const count = decodePositiveInteger(command.count);
    const durationMs = decodePositiveInteger(command.durationMs);
    const intervalMs = decodeNonNegativeInteger(command.intervalMs ?? command.delayMs);
    const maxCommands = decodePositiveInteger(command.maxCommands) ??
        RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands;
    const childCommandCount = Math.max(1, command.commands.length);
    const limitErrors = computeLoopLimitErrors({ command, count, durationMs, intervalMs });

    if (count !== undefined) {
        return toCountedLoopEstimate({
            count,
            childCommandCount,
            maxCommands,
            durationMs,
            intervalMs,
            limitErrors
        });
    }
    if (durationMs !== undefined) {
        return toTimedLoopEstimate({ durationMs, intervalMs, childCommandCount, maxCommands, limitErrors });
    }
    return {
        estimatedIterations: 1,
        intervalMs,
        warnings: [],
        limitErrors
    };
}

function computeLoopLimitErrors(
    input: Readonly<{
        command: Extract<RallarBlackBoxTestCommand, { kind: 'loop'; }>;
        count?: number;
        durationMs?: number;
        intervalMs?: number;
    }>
): readonly string[] {
    const { command, count, durationMs, intervalMs } = input;
    const limitErrors: string[] = [];

    if (command.count !== undefined && count === undefined) {
        limitErrors.push('loop count must be a positive integer.');
    }
    else if ((count ?? 0) > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount) {
        limitErrors.push(
            `loop count ${count} exceeds ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount}.`
        );
    }

    if (command.durationMs !== undefined && durationMs === undefined) {
        limitErrors.push('loop durationMs must be a positive integer.');
    }
    else if ((durationMs ?? 0) > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs) {
        limitErrors.push(
            `loop durationMs ${durationMs} exceeds ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs}.`
        );
    }

    if ((command.intervalMs ?? command.delayMs) !== undefined && intervalMs === undefined) {
        limitErrors.push('loop intervalMs/delayMs must be a non-negative integer.');
    }

    if (command.maxCommands !== undefined && decodePositiveInteger(command.maxCommands) === undefined) {
        limitErrors.push('loop maxCommands must be a positive integer.');
    }
    return limitErrors;
}

function toCountedLoopEstimate(
    input: Readonly<{
        count: number;
        childCommandCount: number;
        maxCommands: number;
        durationMs?: number;
        intervalMs?: number;
        limitErrors: readonly string[];
    }>
): LoopIterationEstimate {
    const plannedDirectCommands = input.count * input.childCommandCount;
    const limitErrors = input.durationMs === undefined && plannedDirectCommands > input.maxCommands
        ? [
            ...input.limitErrors,
            `loop schedules ${plannedDirectCommands} direct child commands but maxCommands is ${input.maxCommands}.`
        ]
        : input.limitErrors;
    return {
        estimatedIterations: input.count,
        durationMs: input.durationMs,
        intervalMs: input.intervalMs,
        warnings: input.count > 100 && input.intervalMs === 0
            ? [`loop schedules ${input.count} iterations without pacing.`]
            : [],
        limitErrors
    };
}

function toTimedLoopEstimate(
    input: Readonly<{
        durationMs: number;
        intervalMs?: number;
        childCommandCount: number;
        maxCommands: number;
        limitErrors: readonly string[];
    }>
): LoopIterationEstimate {
    const intervalEstimate = input.intervalMs && input.intervalMs > 0
        ? Math.max(1, Math.ceil(input.durationMs / input.intervalMs))
        : RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount;
    const maxCommandEstimate = Math.max(1, Math.floor(input.maxCommands / input.childCommandCount));
    return {
        estimatedIterations: Math.min(
            RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount,
            intervalEstimate,
            maxCommandEstimate
        ),
        durationMs: input.durationMs,
        intervalMs: input.intervalMs,
        warnings: [
            'duration-based loop estimate depends on runtime command latency and can finish earlier or later.',
            ...(input.intervalMs ? [] : ['duration-based loop has no positive pacing interval.'])
        ],
        limitErrors: input.limitErrors
    };
}
