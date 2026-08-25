import {
    nowMs,
    recordRallarTiming,
    type RallarTimingDetails,
    type RallarTimingEventInput,
    type RallarTimingSink
} from '../observability/timing.ts';

export namespace RunTimedAdminOperation {
    export interface Input<TResult> {
        readonly timing: RallarTimingSink | undefined;
        readonly event: RallarTimingEventInput;
        readonly execute: () => Promise<TResult>;
        readonly readResultDetails?: (result: TResult) => RallarTimingDetails;
    }
}

export async function runTimedAdminOperation<TResult>(
    input: RunTimedAdminOperation.Input<TResult>
): Promise<TResult> {
    const startedAt = nowMs();
    try {
        const result = await input.execute();
        recordRallarTiming({
            sink: input.timing,
            event: {
                ...input.event,
                details: {
                    ...input.event.details,
                    ...input.readResultDetails?.(result)
                }
            },
            status: 'ok',
            durationMs: nowMs() - startedAt
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.timing,
            event: input.event,
            status: 'error',
            durationMs: nowMs() - startedAt,
            error
        });
        throw error;
    }
}
