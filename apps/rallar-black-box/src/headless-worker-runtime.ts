import type { ConsoleMessage, Page, Request } from 'playwright';

type DistributedRunSnapshot = Readonly<{
    state?: string;
}>;

type DistributedRunResponse = Readonly<{
    status: number;
    ok: boolean;
    body?: Readonly<{ cancel(): Promise<void>; }> | null;
    json(): Promise<unknown>;
}>;

export type HeadlessWorkerRegistrationSnapshot = Readonly<{
    agents?: readonly Readonly<{
        agentId?: string;
        connected?: boolean;
        status?: string;
    }>[];
}>;

export type WaitForHeadlessWorkerAgentRegistrationInput = Readonly<{
    agentId: string;
    timeoutMs: number;
    pollIntervalMs: number;
    signal?: AbortSignal;
    fetchSnapshot(
        signal: AbortSignal
    ): Promise<HeadlessWorkerRegistrationSnapshot>;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    now(): number;
}>;

export type WaitForDistributedRunTerminalInput = Readonly<{
    runId: string;
    url: string;
    headers?: HeadersInit;
    deadline: number | undefined;
    timeoutMs: number | undefined;
    pollIntervalMs: number;
    signal?: AbortSignal;
    fetch: (
        url: string,
        init?: RequestInit
    ) => Promise<DistributedRunResponse>;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    now: () => number;
    log: (message: string) => void;
}>;

export type WaitForHeadlessWorkerExitInput = Readonly<{
    waitForShutdown(signal: AbortSignal): Promise<void>;
    waitForCompletion(signal: AbortSignal): Promise<void>;
}>;

export type HeadlessWorkerLogger = Readonly<{
    log(message: string): void;
    error(error: unknown): void;
}>;

export type CreateHeadlessWorkerLoggerInput = Readonly<{
    secrets: readonly (string | undefined)[];
    now: () => Date;
    writeLog: (message: string) => void;
    writeError: (message: string) => void;
}>;

export type AttachHeadlessWorkerPageLoggingInput = Readonly<{
    agentId: string;
    browserLogLevel: string;
    page: Pick<Page, 'on'>;
    logger: HeadlessWorkerLogger;
}>;

const HEADLESS_WORKER_SECRET_ENV_KEY =
    /^RALLAR_BLACK_BOX_(?:PASSWORD|CONTROL_TOKEN|CONTROL_READ_TOKEN|AGENT_\d+_(?:PASSWORD|CONTROL_TOKEN))$/;

const TERMINAL_DISTRIBUTED_RUN_STATES = new Set([
    'passed',
    'failed',
    'cancelled',
    'timed-out'
]);

export function redactHeadlessWorkerLogText(
    message: string,
    secrets: readonly (string | undefined)[]
): string {
    const withoutKnownSecrets = [...secrets]
        .filter((secret): secret is string => Boolean(secret))
        .sort((left, right) => right.length - left.length)
        .reduce(
            (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
            message
        );
    return withoutKnownSecrets.replace(
        /((?:token|password|secret)[^=&\s]*=)[^&#\s]*/gi,
        '$1[REDACTED]'
    );
}

export function headlessWorkerLogSecretsFromEnv(
    env: Readonly<Record<string, string | undefined>>
): readonly string[] {
    return Object.entries(env)
        .filter(([key]) => HEADLESS_WORKER_SECRET_ENV_KEY.test(key))
        .map(([, value]) => value?.trim())
        .filter((value): value is string => Boolean(value));
}

export function createHeadlessWorkerLogger(
    input: CreateHeadlessWorkerLoggerInput
): HeadlessWorkerLogger {
    const redact = (message: string) => redactHeadlessWorkerLogText(message, input.secrets);

    return {
        log: (message) => {
            input.writeLog(
                `[rallar-black-box-worker] ${input.now().toISOString()} ${redact(message)}`
            );
        },
        error: (error) => {
            input.writeError(
                `[rallar-black-box-worker] ${redact(headlessWorkerErrorMessage(error))}`
            );
        }
    };
}

export function attachHeadlessWorkerPageLogging(
    input: AttachHeadlessWorkerPageLoggingInput
): void {
    input.page.on('console', (message: ConsoleMessage) => {
        const type = message.type();
        if (shouldLogHeadlessWorkerBrowserConsole(input.browserLogLevel, type)) {
            input.logger.log(
                `agent=${input.agentId} browser.console.${type}: ${message.text()}`
            );
        }
    });
    input.page.on('pageerror', (error: Error) => {
        input.logger.log(
            `agent=${input.agentId} browser.pageerror: ${error.message}`
        );
    });
    if (input.browserLogLevel === 'debug') {
        input.page.on('requestfailed', (request: Request) => {
            const failure = request.failure()?.errorText ?? 'unknown';
            input.logger.log(
                `agent=${input.agentId} browser.requestfailed: ${request.method()} ` +
                    `${request.url()} ${failure}`
            );
        });
    }
}

export function logHeadlessWorkerUiConfirmationFailure(
    input: Readonly<{
        agentId: string;
        error: unknown;
        logger: HeadlessWorkerLogger;
    }>
): void {
    input.logger.log(
        `Agent ${input.agentId} registered in control server; UI confirmation skipped: ${
            headlessWorkerErrorMessage(input.error)
        }`
    );
}

export async function waitForHeadlessWorkerExit(
    input: WaitForHeadlessWorkerExitInput
): Promise<void> {
    const shutdownController = new AbortController();
    const completionController = new AbortController();
    const shutdown = observePromise(
        Promise.resolve().then(() => input.waitForShutdown(shutdownController.signal))
    );
    const completion = observePromise(
        Promise.resolve().then(() => input.waitForCompletion(completionController.signal))
    );
    const winner = await Promise.race([
        shutdown.then((outcome) => ({ source: 'shutdown' as const, outcome })),
        completion.then((outcome) => ({ source: 'completion' as const, outcome }))
    ]);

    if (winner.source === 'shutdown') {
        completionController.abort(new Error('Headless worker shutdown'));
        await completion;
    }
    else {
        shutdownController.abort(
            new Error('Headless worker exit condition completed')
        );
        await shutdown;
    }

    if (winner.outcome.status === 'rejected') {
        throw winner.outcome.reason;
    }
}

export async function waitForHeadlessWorkerAgentRegistration(
    input: WaitForHeadlessWorkerAgentRegistrationInput
): Promise<void> {
    const deadline = input.now() + input.timeoutMs;
    let lastState = 'not seen';
    const timeoutError = () =>
        new Error(
            `Timed out waiting ${input.timeoutMs}ms for agent ${input.agentId} ` +
                `to register in control server snapshot. Last state: ${lastState}`
        );
    const abortScope = createAbortScope({
        parentSignal: input.signal,
        deadline,
        now: input.now,
        timeoutError
    });
    const ensureActive = () => {
        ensureDeadlineActive({
            abortScope,
            deadline,
            now: input.now,
            timeoutError
        });
    };

    try {
        ensureActive();
        while (true) {
            let snapshot: HeadlessWorkerRegistrationSnapshot;
            try {
                snapshot = await raceWithAbort(
                    Promise.resolve().then(() => input.fetchSnapshot(abortScope.signal)),
                    abortScope.signal
                );
                ensureActive();
            }
            catch (error) {
                if (abortScope.signal.aborted) {
                    throw abortReason(abortScope.signal);
                }
                ensureActive();
                lastState = headlessWorkerErrorMessage(error);
                await registrationSleepWithAbort(input, abortScope.signal);
                ensureActive();
                continue;
            }

            const registeredAgent = snapshot.agents?.find((candidate) => candidate.agentId === input.agentId);
            if (registeredAgent?.connected) {
                if (registeredAgent.status === 'failed') {
                    throw new Error(
                        `Agent ${input.agentId} registered with failed runtime status.`
                    );
                }
                return;
            }
            lastState = registeredAgent
                ? `connected=${registeredAgent.connected} status=${registeredAgent.status ?? 'unknown'}`
                : 'not in run snapshot';
            await registrationSleepWithAbort(input, abortScope.signal);
            ensureActive();
        }
    }
    finally {
        abortScope.cleanup();
    }
}

export async function waitForDistributedRunTerminal(
    input: WaitForDistributedRunTerminalInput
): Promise<void> {
    if (input.deadline !== undefined && input.timeoutMs === undefined) {
        throw new Error(
            'timeoutMs is required when a polling deadline is configured'
        );
    }

    const timeoutError = () =>
        new Error(
            `Timed out after ${input.timeoutMs}ms waiting for distributed run ${input.runId} to become terminal at ${
                redactHeadlessWorkerLogText(input.url, [])
            }.`
        );
    const abortScope = createAbortScope({
        parentSignal: input.signal,
        deadline: input.deadline,
        now: input.now,
        timeoutError
    });
    const ensureActive = (response?: DistributedRunResponse) => {
        ensurePollingActive(
            input,
            abortScope,
            timeoutError,
            response
        );
    };
    let lastObservedState = '';
    let malformedJsonCount = 0;

    try {
        ensureActive();
        while (true) {
            let response: DistributedRunResponse;
            try {
                response = await fetchWithAbort(input, abortScope.signal);
                ensureActive(response);
            }
            catch (error) {
                if (abortScope.signal.aborted) {
                    throw abortReason(abortScope.signal);
                }
                ensureActive();
                const state = 'network-error';
                if (lastObservedState !== state) {
                    input.log(`Distributed run ${input.runId} state=${state}`);
                    lastObservedState = state;
                }
                malformedJsonCount = 0;
                await sleepWithAbort(input, abortScope.signal);
                ensureActive();
                continue;
            }
            if (response.status === 404) {
                cancelResponseBodyBestEffort(response);
                ensureActive();
                const state = 'not-created';
                if (lastObservedState !== state) {
                    input.log(`Distributed run ${input.runId} is not created yet.`);
                    lastObservedState = state;
                }
                malformedJsonCount = 0;
                await sleepWithAbort(input, abortScope.signal);
                ensureActive();
                continue;
            }

            if (response.status === 401 || response.status === 403) {
                cancelResponseBodyBestEffort(response);
                ensureActive();
                throw new Error(
                    `Distributed run ${input.runId} returned HTTP ${response.status}; ` +
                        `check GitHub/operator control token configuration for ${
                            redactHeadlessWorkerLogText(input.url, [])
                        }.`
                );
            }

            if (!response.ok) {
                cancelResponseBodyBestEffort(response);
                ensureActive();
                const state = `http-${response.status}`;
                if (lastObservedState !== state) {
                    input.log(
                        `Distributed run ${input.runId} returned HTTP ${response.status}; retrying.`
                    );
                    lastObservedState = state;
                }
                malformedJsonCount = 0;
                await sleepWithAbort(input, abortScope.signal);
                ensureActive();
                continue;
            }

            let snapshot: DistributedRunSnapshot;
            try {
                snapshot = await raceWithAbort(
                    Promise.resolve().then(() => response.json()),
                    abortScope.signal
                ) as DistributedRunSnapshot;
            }
            catch (error) {
                ensureActive(response);
                malformedJsonCount += 1;
                if (malformedJsonCount >= 3) {
                    throw new Error(
                        `Distributed run ${input.runId} returned malformed JSON from ${
                            redactHeadlessWorkerLogText(input.url, [])
                        } for ${malformedJsonCount} consecutive polls.`
                    );
                }
                await sleepWithAbort(input, abortScope.signal);
                ensureActive();
                continue;
            }
            ensureActive(response);

            malformedJsonCount = 0;
            const state = snapshot.state ?? 'unknown';
            if (lastObservedState !== state) {
                input.log(`Distributed run ${input.runId} state=${state}`);
                lastObservedState = state;
            }
            if (TERMINAL_DISTRIBUTED_RUN_STATES.has(state)) {
                return;
            }
            await sleepWithAbort(input, abortScope.signal);
            ensureActive();
        }
    }
    finally {
        abortScope.cleanup();
    }
}

type PromiseObservation<T> =
    | Readonly<{ status: 'fulfilled'; value: T; }>
    | Readonly<{ status: 'rejected'; reason: unknown; }>;

function observePromise<T>(promise: Promise<T>): Promise<PromiseObservation<T>> {
    return promise.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason })
    );
}

function createAbortScope(
    input: Readonly<{
        parentSignal?: AbortSignal;
        deadline: number | undefined;
        now: () => number;
        timeoutError: () => Error;
    }>
): Readonly<{
    signal: AbortSignal;
    abort(reason: unknown): void;
    cleanup(): void;
}> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (reason: unknown) => {
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };
    const abortFromParent = () => {
        abort(abortReason(input.parentSignal!));
    };
    const cleanup = () => {
        if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        input.parentSignal?.removeEventListener('abort', abortFromParent);
    };

    if (input.parentSignal?.aborted) {
        abortFromParent();
    }
    else {
        input.parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    if (input.deadline !== undefined && !controller.signal.aborted) {
        timeout = setTimeout(() => {
            abort(input.timeoutError());
        }, Math.max(0, input.deadline - input.now()));
    }

    return { signal: controller.signal, abort, cleanup };
}

function ensureDeadlineActive(
    input: Readonly<{
        abortScope: Readonly<{
            signal: AbortSignal;
            abort(reason: unknown): void;
        }>;
        deadline: number;
        now(): number;
        timeoutError(): Error;
    }>
): void {
    if (input.abortScope.signal.aborted) {
        throw abortReason(input.abortScope.signal);
    }
    if (input.now() >= input.deadline) {
        const reason = input.timeoutError();
        input.abortScope.abort(reason);
        throw reason;
    }
}

function ensurePollingActive(
    input: WaitForDistributedRunTerminalInput,
    abortScope: Readonly<{
        signal: AbortSignal;
        abort(reason: unknown): void;
    }>,
    timeoutError: () => Error,
    response?: DistributedRunResponse
): void {
    let reason: unknown;
    if (abortScope.signal.aborted) {
        reason = abortReason(abortScope.signal);
    }
    else if (
        input.deadline !== undefined &&
        input.now() >= input.deadline
    ) {
        reason = timeoutError();
        abortScope.abort(reason);
    }
    else {
        return;
    }

    if (response) {
        cancelResponseBodyBestEffort(response);
    }
    throw reason;
}

async function fetchWithAbort(
    input: WaitForDistributedRunTerminalInput,
    signal: AbortSignal
): Promise<DistributedRunResponse> {
    throwIfAborted(signal);
    const pending = Promise.resolve().then(() => input.fetch(input.url, { headers: input.headers, signal }));
    void pending.then(
        (response) => {
            if (signal.aborted) {
                cancelResponseBodyBestEffort(response);
            }
        },
        () => undefined
    );
    return await raceWithAbort(pending, signal);
}

async function sleepWithAbort(
    input: WaitForDistributedRunTerminalInput,
    signal: AbortSignal
): Promise<void> {
    throwIfAborted(signal);
    await raceWithAbort(
        Promise.resolve().then(() => input.sleep(input.pollIntervalMs, signal)),
        signal
    );
}

async function registrationSleepWithAbort(
    input: WaitForHeadlessWorkerAgentRegistrationInput,
    signal: AbortSignal
): Promise<void> {
    throwIfAborted(signal);
    await raceWithAbort(
        Promise.resolve().then(() => input.sleep(input.pollIntervalMs, signal)),
        signal
    );
}

function cancelResponseBodyBestEffort(
    response: DistributedRunResponse
): void {
    if (!response.body) {
        return;
    }
    try {
        void Promise.resolve(response.body.cancel()).catch(() => undefined);
    }
    catch {
        // Response disposal cannot change polling status or cancellation outcomes.
    }
}

function raceWithAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(abortReason(signal)));

        Promise.resolve(value).then(
            (result) => finish(() => resolve(result)),
            (error) => finish(() => reject(error))
        );

        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw abortReason(signal);
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Operation aborted');
}

function shouldLogHeadlessWorkerBrowserConsole(
    browserLogLevel: string,
    type: string
): boolean {
    if (browserLogLevel === 'debug') {
        return true;
    }
    if (browserLogLevel === 'info') {
        return type !== 'debug';
    }
    return type === 'error' || type === 'warning';
}

function headlessWorkerErrorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
}
