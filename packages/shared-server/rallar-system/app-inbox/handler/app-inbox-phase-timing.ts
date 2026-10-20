import type { PSqlExecutorCounters, PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    nowMs,
    recordRallarTiming,
    type RallarTimingDetails,
    type RallarTimingEventInput,
    type RallarTimingSink
} from '../../observability/timing.ts';

export interface AppInboxPhaseTimingInput {
    readonly sink: RallarTimingSink | undefined;
    readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
    readonly event: RallarTimingEventInput;
}

/**
 * One `app-inbox-phase` line whose details carry the statement and wait deltas the handle reports
 * over the action, when the port counts: a counter scope reports the action's own statements, the
 * shared root handle every statement the executor ran meanwhile.
 */
export async function timeAppInboxPhase<T>(
    input: AppInboxPhaseTimingInput,
    action: () => Promise<T>
): Promise<T> {
    if (!input.sink) {
        return await action();
    }
    const startedAt = nowMs();
    const countersBefore = input.database.getExecutorCounters?.();
    try {
        const value = await action();
        recordRallarTiming({
            sink: input.sink,
            event: toPhaseEvent(input, countersBefore),
            status: 'ok',
            durationMs: nowMs() - startedAt
        });
        return value;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.sink,
            event: toPhaseEvent(input, countersBefore),
            status: 'error',
            durationMs: nowMs() - startedAt,
            error
        });
        throw error;
    }
}

export function toExecutorCounterDeltaDetails(
    before: PSqlExecutorCounters | undefined,
    after: PSqlExecutorCounters | undefined
): RallarTimingDetails {
    if (before === undefined || after === undefined) {
        return {};
    }
    return {
        statements: after.statements - before.statements,
        executorWaitMs: toRoundedMillisecondsDelta(before.executorWaitMs, after.executorWaitMs),
        ...(before.beginWaitMs !== undefined && after.beginWaitMs !== undefined
            ? { beginWaitMs: toRoundedMillisecondsDelta(before.beginWaitMs, after.beginWaitMs) }
            : {})
    };
}

function toRoundedMillisecondsDelta(before: number, after: number): number {
    return Math.round((after - before) * 100) / 100;
}

function toPhaseEvent(
    input: AppInboxPhaseTimingInput,
    countersBefore: PSqlExecutorCounters | undefined
): RallarTimingEventInput {
    return {
        ...input.event,
        details: {
            ...input.event.details,
            ...toExecutorCounterDeltaDetails(countersBefore, input.database.getExecutorCounters?.())
        }
    };
}
