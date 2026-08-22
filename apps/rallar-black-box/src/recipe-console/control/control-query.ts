export const CONTROL_QUERY_FRESHNESS_MS = 15_000;

export type ControlQueryStatus =
    | 'connecting'
    | 'live'
    | 'partial'
    | 'stale'
    | 'offline';

export type ControlQueryReachability =
    | 'unknown'
    | 'reachable'
    | 'unreachable';

export type ControlQueryAuthorization = 'unknown' | 'ready' | 'required';

export type ControlQueryError = Readonly<{
    kind: 'http' | 'network' | 'timeout' | 'aborted' | 'protocol' | 'unknown';
    message: string;
    status?: number;
    reachability?: ControlQueryReachability;
    authorizationRequired?: boolean;
    controlStatus?: number;
    controlStatusText?: string;
    brokerStatus?: number;
    brokerStatusText?: string;
    credentialTrustRequired?: boolean;
}>;

export type ControlQueryResult<Snapshot, Provenance = unknown> = Readonly<{
    completeness: 'complete' | 'partial';
    snapshot: Snapshot;
    provenance?: Provenance;
    authorization?: ControlQueryAuthorization;
}>;

export type ControlQuerySnapshot<Snapshot, Provenance = unknown> = Readonly<{
    status: ControlQueryStatus;
    reachability: ControlQueryReachability;
    authorization: ControlQueryAuthorization;
    snapshot?: Snapshot;
    completeness?: ControlQueryResult<Snapshot>['completeness'];
    provenance?: Provenance;
    attemptedAtEpochMs?: number;
    receivedAtEpochMs?: number;
    isRefreshing: boolean;
    lastError?: ControlQueryError;
}>;

export type ControlQueryEvent<Snapshot, Provenance = unknown> =
    | Readonly<{ type: 'attempt-started'; atEpochMs: number; }>
    | Readonly<{
        type: 'attempt-succeeded';
        atEpochMs: number;
        result: ControlQueryResult<Snapshot, Provenance>;
    }>
    | Readonly<{
        type: 'attempt-failed';
        atEpochMs: number;
        error: ControlQueryError;
    }>;

export function createInitialControlQueryState<Snapshot, Provenance = unknown>(): ControlQuerySnapshot<
    Snapshot,
    Provenance
> {
    return {
        status: 'connecting',
        reachability: 'unknown',
        authorization: 'unknown',
        isRefreshing: false
    };
}

export function transitionControlQueryState<Snapshot, Provenance = unknown>(
    state: ControlQuerySnapshot<Snapshot, Provenance>,
    event: ControlQueryEvent<Snapshot, Provenance>
): ControlQuerySnapshot<Snapshot, Provenance> {
    const atEpochMs = monotonicEpochMs(state, event.atEpochMs);
    switch (event.type) {
        case 'attempt-started':
            return {
                ...state,
                attemptedAtEpochMs: atEpochMs,
                isRefreshing: true
            };
        case 'attempt-succeeded':
            return {
                status: event.result.completeness === 'complete' ? 'live' : 'partial',
                reachability: 'reachable',
                authorization: event.result.authorization ?? 'ready',
                snapshot: event.result.snapshot,
                completeness: event.result.completeness,
                provenance: event.result.provenance,
                attemptedAtEpochMs: state.attemptedAtEpochMs ?? atEpochMs,
                receivedAtEpochMs: atEpochMs,
                isRefreshing: false
            };
        case 'attempt-failed': {
            const authorizationRequired = event.error.authorizationRequired === true ||
                event.error.kind === 'http' &&
                    (event.error.status === 401 || event.error.status === 403);
            return {
                ...state,
                status: state.snapshot === undefined ? 'offline' : 'stale',
                reachability: event.error.reachability ?? (
                    event.error.kind === 'http' ||
                        event.error.kind === 'protocol'
                        ? 'reachable'
                        : event.error.kind === 'network' || event.error.kind === 'timeout'
                        ? 'unreachable'
                        : 'unknown'
                ),
                authorization: authorizationRequired
                    ? 'required'
                    : state.authorization,
                attemptedAtEpochMs: state.attemptedAtEpochMs ?? atEpochMs,
                isRefreshing: false,
                lastError: event.error
            };
        }
    }
}

export function observeControlQueryFreshness<Snapshot, Provenance = unknown>(
    state: ControlQuerySnapshot<Snapshot, Provenance>,
    nowEpochMs: number,
    freshnessMs = CONTROL_QUERY_FRESHNESS_MS
): ControlQuerySnapshot<Snapshot, Provenance> {
    if (
        state.snapshot === undefined ||
        state.receivedAtEpochMs === undefined ||
        (state.status !== 'live' && state.status !== 'partial') ||
        nowEpochMs - state.receivedAtEpochMs <= freshnessMs
    ) {
        return state;
    }
    return {
        ...state,
        status: 'stale'
    };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type ControlQueryScheduler = Readonly<{
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}>;

export type ControlQueryServiceOptions<Snapshot, Provenance = unknown> = Readonly<{
    query(input: Readonly<{ signal: AbortSignal; }>): Promise<ControlQueryResult<Snapshot, Provenance>>;
    now(): number;
    scheduler: ControlQueryScheduler;
    pollIntervalMs: number;
    requestTimeoutMs: number;
    freshnessMs?: number;
}>;

export type ControlQueryService<Snapshot, Provenance = unknown> = Readonly<{
    start(): void;
    stop(): void;
    refresh(): Promise<void>;
    refreshAfterCurrent(): Promise<void>;
    getSnapshot(): ControlQuerySnapshot<Snapshot, Provenance>;
    subscribe(listener: () => void): () => void;
}>;

export function createControlQueryService<Snapshot, Provenance = unknown>(
    options: ControlQueryServiceOptions<Snapshot, Provenance>
): ControlQueryService<Snapshot, Provenance> {
    let state = createInitialControlQueryState<Snapshot, Provenance>();
    let running = false;
    let generation = 0;
    let pollTimer: TimerHandle | undefined;
    let requestTimer: TimerHandle | undefined;
    let requestController: AbortController | undefined;
    let activeRequestId: number | undefined;
    let nextRequestId = 0;
    let inFlight: Promise<void> | undefined;
    const listeners = new Set<() => void>();

    function publish(next: ControlQuerySnapshot<Snapshot, Provenance>): void {
        if (next === state) {
            return;
        }
        state = next;
        listeners.forEach((listener) => listener());
    }

    function clearPollTimer(): void {
        if (pollTimer !== undefined) {
            options.scheduler.clearTimeout(pollTimer);
            pollTimer = undefined;
        }
    }

    function schedulePoll(currentGeneration: number): void {
        if (!running || currentGeneration !== generation) {
            return;
        }
        clearPollTimer();
        pollTimer = options.scheduler.setTimeout(() => {
            pollTimer = undefined;
            if (running && currentGeneration === generation) {
                void refresh();
            }
        }, options.pollIntervalMs);
    }

    function refresh(): Promise<void> {
        if (inFlight) {
            return inFlight;
        }
        if (!running) {
            running = true;
            generation += 1;
        }
        clearPollTimer();
        const currentGeneration = generation;
        const requestId = ++nextRequestId;
        activeRequestId = requestId;
        publish(transitionControlQueryState(
            observeControlQueryFreshness(
                state,
                options.now(),
                options.freshnessMs ?? CONTROL_QUERY_FRESHNESS_MS
            ),
            {
                type: 'attempt-started',
                atEpochMs: options.now()
            }
        ));

        const controller = new AbortController();
        requestController = controller;
        let timeoutHandle!: TimerHandle;
        let timedOut = false;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutHandle = options.scheduler.setTimeout(() => {
                timedOut = true;
                reject(new ControlQueryTimeoutError(options.requestTimeoutMs));
                controller.abort();
            }, options.requestTimeoutMs);
            requestTimer = timeoutHandle;
        });
        let query: Promise<ControlQueryResult<Snapshot, Provenance>>;
        try {
            query = options.query({ signal: controller.signal });
        }
        catch (error) {
            query = Promise.reject(error);
        }

        let request!: Promise<void>;
        request = (async () => {
            try {
                const result = await Promise.race([query, timeout]);
                if (running && currentGeneration === generation) {
                    publish(transitionControlQueryState(state, {
                        type: 'attempt-succeeded',
                        atEpochMs: options.now(),
                        result
                    }));
                }
            }
            catch (error) {
                if (running && currentGeneration === generation) {
                    publish(transitionControlQueryState(state, {
                        type: 'attempt-failed',
                        atEpochMs: options.now(),
                        error: controlQueryError(
                            timedOut
                                ? new ControlQueryTimeoutError(options.requestTimeoutMs)
                                : error
                        )
                    }));
                }
            }
            finally {
                if (activeRequestId === requestId) {
                    options.scheduler.clearTimeout(timeoutHandle);
                    if (requestTimer === timeoutHandle) {
                        requestTimer = undefined;
                    }
                    if (requestController === controller) {
                        requestController = undefined;
                    }
                    activeRequestId = undefined;
                }
                if (inFlight === request) {
                    inFlight = undefined;
                }
                schedulePoll(currentGeneration);
            }
        })();
        inFlight = request;
        return request;
    }

    function refreshAfterCurrent(): Promise<void> {
        const current = inFlight;
        if (!current) {
            return refresh();
        }
        const currentGeneration = generation;
        return current.then(() => {
            if (!running || generation !== currentGeneration) {
                return;
            }
            return refresh();
        });
    }

    function start(): void {
        if (running) {
            return;
        }
        running = true;
        generation += 1;
        void refresh();
    }

    function stop(): void {
        if (!running && !inFlight && pollTimer === undefined) {
            return;
        }
        running = false;
        generation += 1;
        clearPollTimer();
        if (requestTimer !== undefined) {
            options.scheduler.clearTimeout(requestTimer);
            requestTimer = undefined;
        }
        requestController?.abort();
        requestController = undefined;
        activeRequestId = undefined;
        inFlight = undefined;
        if (state.isRefreshing) {
            publish({
                ...state,
                isRefreshing: false
            });
        }
    }

    return {
        start,
        stop,
        refresh,
        refreshAfterCurrent,
        getSnapshot: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

function monotonicEpochMs<Snapshot>(
    state: ControlQuerySnapshot<Snapshot>,
    atEpochMs: number
): number {
    return Math.max(
        atEpochMs,
        state.attemptedAtEpochMs ?? atEpochMs,
        state.receivedAtEpochMs ?? atEpochMs
    );
}

class ControlQueryTimeoutError extends Error {
    readonly timeout = true;

    constructor(timeoutMs: number) {
        super(`Control server request timed out after ${timeoutMs} ms.`);
        this.name = 'ControlQueryTimeoutError';
    }
}

function controlQueryError(error: unknown): ControlQueryError {
    if (error instanceof ControlQueryTimeoutError) {
        return {
            kind: 'timeout',
            message: error.message
        };
    }
    const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (record?.authorizationRequired === true) {
        const brokerError = record.brokerError;
        const broker = brokerError === undefined
            ? typeof record.status === 'number'
                ? { kind: 'http' as const, message, status: record.status }
                : { kind: 'unknown' as const, message }
            : controlQueryError(brokerError);
        return {
            ...broker,
            message,
            reachability: record.reachable === true
                ? 'reachable'
                : broker.reachability,
            authorizationRequired: true,
            controlStatus: numberProperty(record, 'controlStatus') ??
                (brokerError === undefined
                    ? numberProperty(record, 'status')
                    : undefined),
            controlStatusText: stringProperty(record, 'controlStatusText') ??
                (brokerError === undefined
                    ? stringProperty(record, 'statusText')
                    : undefined),
            brokerStatus: numberProperty(record, 'brokerStatus') ??
                (brokerError === undefined ? undefined : broker.status),
            brokerStatusText: stringProperty(record, 'brokerStatusText'),
            credentialTrustRequired: record.credentialTrustRequired === true || undefined
        };
    }
    if (typeof record?.status === 'number') {
        return {
            kind: 'http',
            status: record.status,
            message
        };
    }
    if (record?.reachable === true) {
        return {
            kind: 'protocol',
            message
        };
    }
    if (record?.name === 'AbortError') {
        return {
            kind: 'aborted',
            message
        };
    }
    if (error instanceof TypeError) {
        return {
            kind: 'network',
            message
        };
    }
    return {
        kind: 'unknown',
        message
    };
}

function numberProperty(
    record: Record<string, unknown>,
    key: string
): number | undefined {
    return typeof record[key] === 'number' ? record[key] : undefined;
}

function stringProperty(
    record: Record<string, unknown>,
    key: string
): string | undefined {
    return typeof record[key] === 'string' ? record[key] : undefined;
}
