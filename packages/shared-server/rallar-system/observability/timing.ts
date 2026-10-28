import { toError } from '@shared/resilience/to-error.ts';

export type RallarTimingStatus = 'ok' | 'error';

export type RallarTimingDetails = Readonly<Record<string, string | number | boolean | undefined>>;

export type RallarTimingEvent = Readonly<{
    type: 'rallar.timing';
    component: string;
    operation: string;
    status: RallarTimingStatus;
    durationMs: number;
    atEpochMs: number;
    serviceId?: string;
    requestId?: string;
    /**
     * The trace of the request or message the line describes. Absent exactly where the producer holds neither:
     * - the AppInbox dequeue pass and the dequeue-pass boundary, the computed queue failure's transaction line, and the
     *   retry-exhaustion transaction and telemetry lines, which hold a queue entry but no decoded message;
     * - the ALM outbound dequeue, captured-policy and Postgres release lines and the queuebox pub/sub lines, which see
     *   claimed rows, batches or key notices, never a decoded message;
     * - the group-state service's ingress captures, sweeps and storage reads (every operation but a queued mutation's
     *   read), the principal group list and the REST snapshot read diagnostics, whose contracts carry no message;
     * - process and harness samples: event-loop lag, heap, the Postgres statement census, the black-box control
     *   server's lines and the state-write benchmark SQL.
     */
    traceId?: string;
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    principalId?: string;
    sessionId?: string;
    method?: string;
    path?: string;
    httpStatus?: number;
    details?: RallarTimingDetails;
    error?: Readonly<{
        name?: string;
        message: string;
    }>;
}>;

export type RallarTimingEventInput = Omit<RallarTimingEvent, 'type' | 'status' | 'durationMs' | 'atEpochMs' | 'error'>;

export type RallarTimingSink = (event: RallarTimingEvent) => void;

export interface RecordRallarTimingInput {
    readonly sink: RallarTimingSink | undefined;
    readonly event: RallarTimingEventInput;
    readonly status: RallarTimingStatus;
    readonly durationMs: number;
    readonly error?: Error;
}

export function recordRallarTiming(input: RecordRallarTimingInput): void {
    const { sink, event, status, durationMs, error } = input;
    if (!sink) {
        return;
    }

    try {
        sink({
            ...event,
            type: 'rallar.timing',
            status,
            durationMs: toRoundedDurationMs(durationMs),
            atEpochMs: Date.now(),
            ...(error === undefined ? {} : { error: toTimingError(error) })
        });
    }
    catch {
        // Timing must never affect request or state mutation behavior.
    }
}

export async function timeRallarAsync<T>(
    sink: RallarTimingSink | undefined,
    input: RallarTimingEventInput,
    action: () => Promise<T>
): Promise<T> {
    if (!sink) {
        return await action();
    }

    const startedAt = nowMs();
    try {
        const value = await action();
        recordRallarTiming({
            sink,
            event: input,
            status: 'ok',
            durationMs: nowMs() - startedAt
        });
        return value;
    }
    catch (error) {
        recordRallarTiming({
            sink,
            event: input,
            status: 'error',
            durationMs: nowMs() - startedAt,
            error: toError(error)
        });
        throw error;
    }
}

export function createConsoleRallarTimingSink(
    options: Readonly<{
        enabled?: boolean;
        logger?: (message: string) => void;
    }> = {}
): RallarTimingSink {
    const enabled = options.enabled ?? true;
    const logger = options.logger ?? console.info;

    return (event) => {
        if (enabled) {
            logger(JSON.stringify(event));
        }
    };
}

export function nowMs(): number {
    return typeof performance !== 'undefined'
        ? performance.now()
        : Date.now();
}

function toRoundedDurationMs(durationMs: number): number {
    return Math.round(durationMs * 100) / 100;
}

function toTimingError(error: Error): RallarTimingEvent['error'] {
    return { name: error.name, message: error.message };
}
