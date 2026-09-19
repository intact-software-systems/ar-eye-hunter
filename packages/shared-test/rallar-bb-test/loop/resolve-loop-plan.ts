import { Either } from '@shared/resilience/Either.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestLoopThresholds,
    type RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { decodeNonNegativeInteger, decodePositiveInteger } from '../runtime/decode-runtime-result-values.ts';
import { decodeLoopThresholds } from './loop-command-thresholds.ts';
import { validateLoopUntilCommand } from './loop-until.ts';
import { toLoopInvalidOutcome, toLoopLimitExceededOutcome } from './to-loop-outcome.ts';

export type LoopCommandWithId = RallarBlackBoxTestLoopCommand & Readonly<{ commandId: string; }>;

export interface LoopPlan {
    readonly count: number;
    /** Absent for a count-bounded loop. */
    readonly durationMs?: number;
    readonly intervalMs: number;
    readonly maxCommands: number;
    readonly plannedCommandCount: number;
    readonly thresholds: RallarBlackBoxTestLoopThresholds;
}

type LoopPlanResult = Either<RallarBlackBoxTestCommandOutcome, LoopPlan>;

type LoopBoundsResult = Either<RallarBlackBoxTestCommandOutcome, Pick<LoopPlan, 'count' | 'durationMs'>>;

const LIMITS = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS;

export function resolveLoopPlan(command: LoopCommandWithId): LoopPlanResult {
    if (!Array.isArray(command.commands) || command.commands.length === 0) {
        return toInvalid(command, 'Loop requires at least one child command.', undefined);
    }
    return resolveLoopBounds(command).fold(
        (invalid) => Either.ofLeft(invalid),
        (bounds) => resolveLoopWorkLimit(command, bounds)
    );
}

function resolveLoopBounds(command: LoopCommandWithId): LoopBoundsResult {
    const durationMs = command.durationMs === undefined ? undefined : decodePositiveInteger(command.durationMs);
    if (command.durationMs !== undefined && durationMs === undefined) {
        return toInvalid(command, 'Loop durationMs must be a positive integer.', { durationMs: command.durationMs });
    }
    if (durationMs !== undefined && durationMs > LIMITS.maxLoopDurationMs) {
        return toInvalid(command, 'Loop durationMs exceeds the runtime maximum.', {
            durationMs,
            maxLoopDurationMs: LIMITS.maxLoopDurationMs
        });
    }
    const defaultCount = durationMs === undefined ? 1 : LIMITS.maxLoopCount;
    const count = command.count === undefined ? defaultCount : decodePositiveInteger(command.count);
    if (count === undefined) {
        return toInvalid(command, 'Loop count must be a positive integer.', { count: command.count });
    }
    return count > LIMITS.maxLoopCount
        ? toInvalid(command, 'Loop count exceeds the runtime maximum.', { count, maxLoopCount: LIMITS.maxLoopCount })
        : Either.ofRight({ count, durationMs });
}

function resolveLoopWorkLimit(
    command: LoopCommandWithId,
    bounds: Pick<LoopPlan, 'count' | 'durationMs'>
): LoopPlanResult {
    const interval = command.intervalMs ?? command.delayMs;
    const intervalMs = interval === undefined ? 0 : decodeNonNegativeInteger(interval);
    if (intervalMs === undefined) {
        return toInvalid(command, 'Loop intervalMs/delayMs must be a non-negative integer.', {
            intervalMs: command.intervalMs,
            delayMs: command.delayMs
        });
    }
    const requestedMaxCommands = command.maxCommands === undefined
        ? LIMITS.maxExpandedCommands
        : decodePositiveInteger(command.maxCommands);
    if (requestedMaxCommands === undefined) {
        return toInvalid(command, 'Loop maxCommands must be a positive integer.', { maxCommands: command.maxCommands });
    }
    const maxCommands = Math.min(requestedMaxCommands, LIMITS.maxExpandedCommands);
    const plannedCommandCount = bounds.count * command.commands.length;
    if (bounds.durationMs === undefined && plannedCommandCount > maxCommands) {
        return Either.ofLeft(
            toLoopLimitExceededOutcome({ commandId: command.commandId, results: [] }, {
                plannedCommandCount,
                maxCommands
            })
        );
    }
    return resolveLoopPolicies(command, { ...bounds, intervalMs, maxCommands, plannedCommandCount });
}

function resolveLoopPolicies(command: LoopCommandWithId, plan: Omit<LoopPlan, 'thresholds'>): LoopPlanResult {
    return decodeLoopThresholds(command.thresholds).fold(
        (issue) => toInvalid(command, issue.message, issue.details),
        (thresholds) => {
            const untilIssue = validateLoopUntilCommand(command).at(0);
            return untilIssue === undefined
                ? Either.ofRight({ ...plan, thresholds })
                : toInvalid(command, untilIssue.message, untilIssue.details);
        }
    );
}

function toInvalid<T>(
    command: LoopCommandWithId,
    message: string,
    details: RallarBlackBoxTestRecord | undefined
): Either<RallarBlackBoxTestCommandOutcome, T> {
    return Either.ofLeft(toLoopInvalidOutcome(command.commandId, message, details));
}
