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
    readonly error?: unknown;
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
            error
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

function toTimingError(error: unknown): RallarTimingEvent['error'] {
    return {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error)
    };
}
