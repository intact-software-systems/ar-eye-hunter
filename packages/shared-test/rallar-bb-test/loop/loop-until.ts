import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestCompositeChildResult,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestLoopThresholdFailure,
    RallarBlackBoxTestLoopResultValue,
} from '../types.ts';

export const RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED = 'RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED';

const DEFAULT_BACKOFF_MULTIPLIER = 1;

type LoopCommandWithId = RallarBlackBoxTestLoopCommand & Readonly<{ commandId: string }>;

export type LoopIterationOutcome =
    | Readonly<{ kind: 'completed'; failedChildResult?: RallarBlackBoxTestCompositeChildResult }>
    | Readonly<{ kind: 'outcome'; outcome: RallarBlackBoxTestCommandOutcome }>;

export interface LoopUntilValidationIssue {
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

export function validateLoopUntilCommand(
    command: LoopCommandWithId,
): readonly LoopUntilValidationIssue[] {
    const issues: LoopUntilValidationIssue[] = [];
    if (command.until !== undefined && command.until !== 'first-success') {
        issues.push({
            message: "Loop until must be 'first-success' when present.",
            details: { until: command.until },
        });
    }
    if (command.backoffMultiplier !== undefined) {
        if (command.until === undefined) {
            issues.push({
                message: 'Loop backoffMultiplier requires until mode.',
                details: { backoffMultiplier: command.backoffMultiplier },
            });
        }
        if (
            typeof command.backoffMultiplier !== 'number' ||
            !Number.isFinite(command.backoffMultiplier) ||
            command.backoffMultiplier < 1
        ) {
            issues.push({
                message: 'Loop backoffMultiplier must be a finite number of at least 1.',
                details: { backoffMultiplier: command.backoffMultiplier },
            });
        }
    }
    if (command.until !== undefined && command.continueOnFailure === true) {
        issues.push({
            message: 'Loop continueOnFailure contradicts until mode and is rejected.',
            details: { until: command.until, continueOnFailure: command.continueOnFailure },
        });
    }
    return issues;
}

export interface RunLoopUntilFirstSuccessInput {
    readonly command: LoopCommandWithId;
    readonly count: number;
    readonly durationMs?: number;
    readonly intervalMs: number;
    readonly deadlineEpochMs?: number;
    readonly loopStartedAtEpochMs: number;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly isAbortError: (error: unknown) => boolean;
    readonly cancelRequested: () => boolean;
    readonly runIteration: (
        iterationIndex: number,
        scheduledAtEpochMs: number,
    ) => Promise<LoopIterationOutcome>;
    readonly toLoopValue: (
        cancelled: boolean,
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[],
    ) => RallarBlackBoxTestLoopResultValue;
    readonly toTimedOutOutcome: () => RallarBlackBoxTestCommandOutcome;
    readonly toSuccessOutcome: () => RallarBlackBoxTestCommandOutcome;
}

// The runner's http.poll-until twin: every attempt runs the children in
// order, the first attempt in which every child succeeds ends the loop, and
// exhausting count/duration/deadline bounds fails with the last attempt's
// failing child so convergence failures stay diagnosable.
export async function runLoopUntilFirstSuccess(
    input: RunLoopUntilFirstSuccessInput,
): Promise<RallarBlackBoxTestCommandOutcome> {
    const backoffMultiplier = input.command.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    let lastFailedChildResult: RallarBlackBoxTestCompositeChildResult | undefined;
    let attempts = 0;
    let nextScheduledAtEpochMs = input.loopStartedAtEpochMs;

    for (let iterationIndex = 0; iterationIndex < input.count; iterationIndex++) {
        if (input.cancelRequested()) {
            return cancelledOutcome(input);
        }
        if (input.deadlineEpochMs !== undefined && input.now() >= input.deadlineEpochMs) {
            return input.toTimedOutOutcome();
        }
        const elapsedMs = Math.max(0, input.now() - input.loopStartedAtEpochMs);
        if (input.durationMs !== undefined && iterationIndex > 0 && elapsedMs >= input.durationMs) {
            break;
        }

        attempts += 1;
        const iteration = await input.runIteration(iterationIndex, nextScheduledAtEpochMs);
        if (iteration.kind === 'outcome') {
            return iteration.outcome;
        }
        if (iteration.failedChildResult === undefined) {
            return input.toSuccessOutcome();
        }
        lastFailedChildResult = iteration.failedChildResult;

        if (iterationIndex + 1 >= input.count) {
            break;
        }
        const elapsedAfterMs = Math.max(0, input.now() - input.loopStartedAtEpochMs);
        if (input.durationMs !== undefined && elapsedAfterMs >= input.durationMs) {
            break;
        }

        const backoffDelayMs = Math.round(
            input.intervalMs * Math.pow(backoffMultiplier, iterationIndex),
        );
        nextScheduledAtEpochMs = input.now() + backoffDelayMs;
        if (backoffDelayMs > 0) {
            const boundedDelayMs = input.deadlineEpochMs === undefined
                ? backoffDelayMs
                : Math.max(0, Math.min(backoffDelayMs, input.deadlineEpochMs - input.now()));
            try {
                await input.sleep(boundedDelayMs);
            } catch (error) {
                if (input.isAbortError(error)) {
                    return cancelledOutcome(input);
                }
                throw error;
            }
            if (input.deadlineEpochMs !== undefined && input.now() >= input.deadlineEpochMs) {
                return input.toTimedOutOutcome();
            }
        }
    }

    return {
        status: 'failed',
        value: input.toLoopValue(false),
        error: {
            code: RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED,
            message: `Loop until mode exhausted ${attempts} attempt(s) without a fully passing iteration.`,
            details: {
                attempts,
                count: input.count,
                durationMs: input.durationMs,
                deadlineEpochMs: input.deadlineEpochMs,
                backoffMultiplier,
                lastFailedChildResult,
            },
        },
        nextStatus: 'failed',
    };
}

function cancelledOutcome(
    input: RunLoopUntilFirstSuccessInput,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'cancelled',
        value: input.toLoopValue(true),
        nextStatus: 'cancelled',
    };
}
