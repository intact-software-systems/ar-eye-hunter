import type { ConsoleMessage, Page, Request } from 'playwright';

import { toError } from '@shared/resilience/to-error.ts';

interface DistributedRunResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly body?: Readonly<{ cancel(): Promise<void>; }> | null;
    json(): Promise<unknown>;
}

export interface HeadlessWorkerRegistrationSnapshot {
    readonly agents?: readonly Readonly<{
        agentId?: string;
        connected?: boolean;
        status?: string;
    }>[];
}

export interface WaitForHeadlessWorkerAgentRegistrationInput {
    readonly agentId: string;
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
    readonly signal?: AbortSignal;
    fetchSnapshot(
        signal: AbortSignal
    ): Promise<HeadlessWorkerRegistrationSnapshot>;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    now(): number;
    /**
     * The agent page's own status line. An agent that refuses to start never reaches the control
     * run snapshot, so its reason is only on the page.
     */
    readAgentPageStatus(): Promise<string | undefined>;
    /** Why the API refused the agent page's sign-in; such an agent never registers in the control run. */
    readSignInRefusal(): Promise<string | undefined>;
}

export interface WaitForDistributedRunTerminalInput {
    readonly runId: string;
    readonly url: string;
    readonly headers?: HeadersInit;
    readonly deadline: number | undefined;
    readonly timeoutMs: number | undefined;
    readonly pollIntervalMs: number;
    readonly signal?: AbortSignal;
    readonly fetch: (
        url: string,
        init?: RequestInit
    ) => Promise<DistributedRunResponse>;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly now: () => number;
    readonly log: (message: string) => void;
}

export interface WaitForHeadlessWorkerExitInput {
    waitForShutdown(signal: AbortSignal): Promise<void>;
    waitForCompletion(signal: AbortSignal): Promise<void>;
}

export interface HeadlessWorkerLogger {
    log(message: string): void;
    error(error: Error): void;
}

export interface CreateHeadlessWorkerLoggerInput {
    readonly secrets: readonly (string | undefined)[];
    readonly now: () => Date;
    readonly writeLog: (message: string) => void;
    readonly writeError: (message: string) => void;
}

export interface AttachHeadlessWorkerPageLoggingInput {
    readonly agentId: string;
    readonly browserLogLevel: string;
    readonly page: Pick<Page, 'on'>;
    readonly logger: HeadlessWorkerLogger;
}

export interface LogHeadlessWorkerUiConfirmationFailureInput {
    readonly agentId: string;
    readonly error: Error;
    readonly logger: HeadlessWorkerLogger;
}

type HeadlessWorkerRegistrationObservation =
    | Readonly<{ kind: 'snapshot'; snapshot: HeadlessWorkerRegistrationSnapshot; }>
    | Readonly<{ kind: 'unavailable'; failure: string; }>;

type HeadlessWorkerAgentRegistrationState =
    | Readonly<{ kind: 'registered'; }>
    | Readonly<{ kind: 'pending'; lastState: string; }>
    | Readonly<{ kind: 'failed'; failure: string; }>;

type PromiseObservation<T> =
    | Readonly<{ status: 'fulfilled'; value: T; }>
    | Readonly<{ status: 'rejected'; reason: Error; }>;

interface HeadlessWorkerAbortScope {
    readonly signal: AbortSignal;
    abort(reason: Error): void;
    cleanup(): void;
}

type DistributedRunPoll =
    | Readonly<{ kind: 'state' | 'retry'; state: string; message: string; }>
    | Readonly<{ kind: 'malformed'; }>;

interface CreateAbortScopeInput {
    readonly parentSignal: AbortSignal | undefined;
    readonly deadline: number | undefined;
    readonly now: () => number;
    readonly timeoutError: () => Error;
}

interface EnsureDeadlineActiveInput {
    readonly abortScope: HeadlessWorkerAbortScope;
    readonly deadline: number;
    readonly now: () => number;
    readonly timeoutError: () => Error;
}

interface EnsureDistributedRunPollingActiveInput {
    readonly polling: WaitForDistributedRunTerminalInput;
    readonly abortScope: HeadlessWorkerAbortScope;
    readonly timeoutError: () => Error;
    readonly response: DistributedRunResponse | undefined;
}

interface ReadDistributedRunPollInput {
    readonly polling: WaitForDistributedRunTerminalInput;
    readonly abortScope: HeadlessWorkerAbortScope;
    readonly ensureActive: (response?: DistributedRunResponse) => void;
}

const HEADLESS_WORKER_SECRET_ENV_KEY =
    /^RALLAR_BLACK_BOX_(?:PASSWORD|CONTROL_TOKEN|CONTROL_READ_TOKEN|AGENT_\d+_(?:PASSWORD|CONTROL_TOKEN))$/;

const MALFORMED_DISTRIBUTED_RUN_POLL_LIMIT = 3;
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

export function toHeadlessWorkerLogSecrets(
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
                `[rallar-black-box-worker] ${redact(toHeadlessWorkerErrorMessage(error))}`
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

export function logHeadlessWorkerUiConfirmationFailure(input: LogHeadlessWorkerUiConfirmationFailureInput): void {
    input.logger.log(
        `Agent ${input.agentId} registered in control server; UI confirmation skipped: ${
            toHeadlessWorkerErrorMessage(input.error)
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
    try {
        await pollForHeadlessWorkerAgentRegistration(input);
    }
    catch (error) {
        throw await toAgentRegistrationFailure(toError(error), input);
    }
}

/** The wait's own failure, named together with whatever the agent page says about itself. */
async function toAgentRegistrationFailure(
    error: Error,
    input: WaitForHeadlessWorkerAgentRegistrationInput
): Promise<Error> {
    const pageStatus = await input.readAgentPageStatus().catch(() => undefined);
    return pageStatus === undefined || pageStatus === ''
        ? error
        : new Error(`${error.message} Agent page status: ${pageStatus}`);
}

async function pollForHeadlessWorkerAgentRegistration(
    input: WaitForHeadlessWorkerAgentRegistrationInput
): Promise<void> {
    const deadline = input.now() + input.timeoutMs;
    let lastState = 'not seen';
    const timeoutError = () =>
        new Error(
            `Timed out waiting ${input.timeoutMs}ms for agent ${input.agentId} ` +
                `to register in control server snapshot. Last state: ${lastState}`
        );
    const abortScope = createAbortScope({ parentSignal: input.signal, deadline, now: input.now, timeoutError });
    const ensureActive = () => ensureDeadlineActive({ abortScope, deadline, now: input.now, timeoutError });

    try {
        ensureActive();
        while (true) {
            const observation = await readRegistrationObservation(input, abortScope.signal);
            ensureActive();
            const registration = toAgentRegistrationState(observation, input.agentId);
            if (registration.kind === 'registered') {
                return;
            }
            if (registration.kind === 'failed') {
                throw new Error(registration.failure);
            }
            lastState = registration.lastState;

            const signInRefusal = await readSignInRefusalWithAbort(input, abortScope.signal);
            if (signInRefusal !== undefined) {
                throw new Error(`Agent ${input.agentId} sign-in refused: ${signInRefusal}`);
            }
            await sleepWithAbort(input, abortScope.signal);
            ensureActive();
        }
    }
    finally {
        abortScope.cleanup();
    }
}

async function readRegistrationObservation(
    input: WaitForHeadlessWorkerAgentRegistrationInput,
    signal: AbortSignal
): Promise<HeadlessWorkerRegistrationObservation> {
    try {
        const snapshot = await raceWithAbort(
            Promise.resolve().then(() => input.fetchSnapshot(signal)),
            signal
        );
        return { kind: 'snapshot', snapshot };
    }
    catch (error) {
        throwIfAborted(signal);
        return { kind: 'unavailable', failure: toHeadlessWorkerErrorMessage(toError(error)) };
    }
}

async function readSignInRefusalWithAbort(
    input: WaitForHeadlessWorkerAgentRegistrationInput,
    signal: AbortSignal
): Promise<string | undefined> {
    const refusal = await raceWithAbort(
        Promise.resolve().then(() => input.readSignInRefusal()),
        signal
    );
    return refusal === '' ? undefined : refusal;
}

function toAgentRegistrationState(
    observation: HeadlessWorkerRegistrationObservation,
    agentId: string
): HeadlessWorkerAgentRegistrationState {
    if (observation.kind === 'unavailable') {
        return { kind: 'pending', lastState: observation.failure };
    }
    const registeredAgent = observation.snapshot.agents?.find((candidate) => candidate.agentId === agentId);
    if (registeredAgent === undefined) {
        return { kind: 'pending', lastState: 'not in run snapshot' };
    }
    if (!registeredAgent.connected) {
        return {
            kind: 'pending',
            lastState: `connected=${registeredAgent.connected} status=${registeredAgent.status ?? 'unknown'}`
        };
    }
    return registeredAgent.status === 'failed'
        ? { kind: 'failed', failure: `Agent ${agentId} registered with failed runtime status.` }
        : { kind: 'registered' };
}

export async function waitForDistributedRunTerminal(input: WaitForDistributedRunTerminalInput): Promise<void> {
    if (input.deadline !== undefined && input.timeoutMs === undefined) {
        throw new Error('timeoutMs is required when a polling deadline is configured');
    }

    const timeoutError = () => toDistributedRunTimeoutError(input);
    const abortScope = createAbortScope({
        parentSignal: input.signal,
        deadline: input.deadline,
        now: input.now,
        timeoutError
    });
    const ensureActive = (response?: DistributedRunResponse) =>
        ensureDistributedRunPollingActive({ polling: input, abortScope, timeoutError, response });
    let lastObservedState = '';
    let malformedJsonCount = 0;

    try {
        ensureActive();
        while (true) {
            const poll = await readDistributedRunPoll({ polling: input, abortScope, ensureActive });
            malformedJsonCount = poll.kind === 'malformed' ? malformedJsonCount + 1 : 0;
            if (malformedJsonCount >= MALFORMED_DISTRIBUTED_RUN_POLL_LIMIT) {
                throw toMalformedDistributedRunError(input, malformedJsonCount);
            }
            if (poll.kind !== 'malformed' && lastObservedState !== poll.state) {
                input.log(poll.message);
                lastObservedState = poll.state;
            }
            if (poll.kind === 'state' && TERMINAL_DISTRIBUTED_RUN_STATES.has(poll.state)) {
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

async function readDistributedRunPoll(input: ReadDistributedRunPollInput): Promise<DistributedRunPoll> {
    const { polling, abortScope, ensureActive } = input;
    let response: DistributedRunResponse;
    try {
        response = await fetchWithAbort(polling, abortScope.signal);
        ensureActive(response);
    }
    catch {
        throwIfAborted(abortScope.signal);
        ensureActive();
        return {
            kind: 'retry',
            state: 'network-error',
            message: `Distributed run ${polling.runId} state=network-error`
        };
    }

    if (!response.ok) {
        cancelResponseBodyBestEffort(response);
        ensureActive();
        if (response.status === 401 || response.status === 403) {
            throw new Error(
                `Distributed run ${polling.runId} returned HTTP ${response.status}; ` +
                    `check GitHub/operator control token configuration for ${
                        redactHeadlessWorkerLogText(polling.url, [])
                    }.`
            );
        }
        return toDistributedRunRetryPoll(polling, response.status);
    }

    const state = await raceWithAbort(Promise.resolve().then(() => response.json()), abortScope.signal).then(
        decodeDistributedRunState,
        () => undefined
    );
    ensureActive(response);
    return state === undefined
        ? { kind: 'malformed' }
        : { kind: 'state', state, message: `Distributed run ${polling.runId} state=${state}` };
}

function toDistributedRunTimeoutError(polling: WaitForDistributedRunTerminalInput): Error {
    return new Error(
        `Timed out after ${polling.timeoutMs}ms waiting for distributed run ${polling.runId} to become terminal at ${
            redactHeadlessWorkerLogText(polling.url, [])
        }.`
    );
}

function toMalformedDistributedRunError(
    polling: WaitForDistributedRunTerminalInput,
    malformedJsonCount: number
): Error {
    return new Error(
        `Distributed run ${polling.runId} returned malformed JSON from ${
            redactHeadlessWorkerLogText(polling.url, [])
        } for ${malformedJsonCount} consecutive polls.`
    );
}

function toDistributedRunRetryPoll(polling: WaitForDistributedRunTerminalInput, status: number): DistributedRunPoll {
    return status === 404
        ? { kind: 'retry', state: 'not-created', message: `Distributed run ${polling.runId} is not created yet.` }
        : {
            kind: 'retry',
            state: `http-${status}`,
            message: `Distributed run ${polling.runId} returned HTTP ${status}; retrying.`
        };
}

function decodeDistributedRunState(value: unknown): string {
    if (typeof value !== 'object' || value === null || !('state' in value)) {
        return 'unknown';
    }
    return typeof value.state === 'string' ? value.state : 'unknown';
}

function observePromise<T>(promise: Promise<T>): Promise<PromiseObservation<T>> {
    return promise.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason: toError(reason) })
    );
}

function createAbortScope(input: CreateAbortScopeInput): HeadlessWorkerAbortScope {
    const { parentSignal } = input;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (reason: Error) => {
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };
    const abortFromParent = () => {
        if (parentSignal !== undefined) {
            abort(abortReason(parentSignal));
        }
    };
    const cleanup = () => {
        if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        parentSignal?.removeEventListener('abort', abortFromParent);
    };

    if (parentSignal?.aborted) {
        abortFromParent();
    }
    else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    if (input.deadline !== undefined && !controller.signal.aborted) {
        timeout = setTimeout(() => {
            abort(input.timeoutError());
        }, Math.max(0, input.deadline - input.now()));
    }

    return { signal: controller.signal, abort, cleanup };
}

function ensureDeadlineActive(input: EnsureDeadlineActiveInput): void {
    if (input.abortScope.signal.aborted) {
        throw abortReason(input.abortScope.signal);
    }
    if (input.now() >= input.deadline) {
        const reason = input.timeoutError();
        input.abortScope.abort(reason);
        throw reason;
    }
}

function ensureDistributedRunPollingActive(input: EnsureDistributedRunPollingActiveInput): void {
    const { abortScope, polling, response } = input;
    let reason: Error;
    if (abortScope.signal.aborted) {
        reason = abortReason(abortScope.signal);
    }
    else if (polling.deadline !== undefined && polling.now() >= polling.deadline) {
        reason = input.timeoutError();
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
    input: Pick<WaitForDistributedRunTerminalInput, 'pollIntervalMs' | 'sleep'>,
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
    return new Promise<T>((resolve, reject) => {
        const rejectWithAbortReason = () => reject(abortReason(signal));
        if (signal.aborted) {
            rejectWithAbortReason();
        }
        else {
            signal.addEventListener('abort', rejectWithAbortReason, { once: true });
        }
        void Promise.resolve(value)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', rejectWithAbortReason));
    });
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw abortReason(signal);
    }
}

function abortReason(signal: AbortSignal): Error {
    return toError(signal.reason ?? new Error('Operation aborted'));
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

function toHeadlessWorkerErrorMessage(error: Error): string {
    return error.stack ?? error.message;
}
