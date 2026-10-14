export interface TryWithInput<T> {
    readonly handler: () => T | Promise<T>;
    readonly retryIntervalMsecs: number;
    readonly maxAttempts: number;
    readonly maxRetryIntervalMsecs: number;
}

export interface TryRunInIntervalsInput<T> {
    readonly handler: () => T | Promise<T>;
    readonly intervalMsecs: number;
    readonly retryIntervalMsecs: number;
    readonly maxAttempts: number;
    /** Stops owned timers and future cycles; an in-flight handler must finish through its own port. */
    readonly signal?: AbortSignal;
}

export interface TryWithRetryContext {
    readonly label?: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly elapsedMsecs: number;
    readonly error: unknown;
}

export interface TryWithRetryScheduledContext extends TryWithRetryContext {
    readonly delayMsecs: number;
    readonly nextAttempt: number;
}

export type TryWithRetryPredicate = (
    error: unknown,
    context: TryWithRetryContext
) => boolean | Promise<boolean>;

export type TryWithRetryObserver = (
    context: TryWithRetryScheduledContext
) => void | Promise<void>;

export type TryWithRetryWait = (context: TryWithRetryScheduledContext) => Promise<void>;

interface TryWithPolicyOptions {
    readonly label?: string;
    readonly maxAttempts: number;
    readonly retryIntervalMsecs: number;
    readonly maxRetryIntervalMsecs: number;
    readonly maxElapsedMsecs?: number;
    readonly backoffFactor: number;
    readonly jitterRatio: number;
    readonly retryIf: TryWithRetryPredicate;
    readonly onRetry?: TryWithRetryObserver;
    readonly waitBeforeRetry?: TryWithRetryWait;
}

interface RetryDelayInput {
    readonly attempt: number;
    readonly baseMsecs: number;
    readonly maxMsecs: number;
    readonly factor: number;
    readonly jitterRatio: number;
    readonly randomUnit: number;
}

export class RetryableConflictError extends Error {
    constructor(message: string = 'Retryable conflict', options?: ErrorOptions) {
        super(message, options);
        this.name = 'RetryableConflictError';
    }
}

export class TryWithExhaustedError extends Error {
    public readonly context: TryWithRetryContext;

    constructor(
        message: string,
        context: TryWithRetryContext,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.context = context;
        this.name = 'TryWithExhaustedError';
    }
}

export namespace TryWithPolicy {
    export interface Dependencies {
        readonly nowEpochMs: () => number;
        readonly randomUnit: () => number;
        readonly wait: (delayMsecs: number) => Promise<void>;
    }
}

export class TryWithPolicy {
    private readonly options: TryWithPolicyOptions;
    private readonly dependencies: TryWithPolicy.Dependencies;

    private constructor(
        options: TryWithPolicyOptions,
        dependencies: TryWithPolicy.Dependencies
    ) {
        this.options = options;
        this.dependencies = dependencies;
    }

    static defaults(dependencies: TryWithPolicy.Dependencies = {
        nowEpochMs: () => Date.now(),
        randomUnit: () => Math.random(),
        wait: sleep
    }): TryWithPolicy {
        return new TryWithPolicy({
            maxAttempts: Number.MAX_SAFE_INTEGER,
            retryIntervalMsecs: 500,
            maxRetryIntervalMsecs: 20_000,
            backoffFactor: 2,
            jitterRatio: 0.2,
            retryIf: () => true
        }, dependencies);
    }

    label(label: string): TryWithPolicy {
        return this.with({ label });
    }

    maxAttempts(maxAttempts: number): TryWithPolicy {
        return this.with({
            maxAttempts: Math.max(1, Math.floor(maxAttempts))
        });
    }

    retryIntervalMsecs(retryIntervalMsecs: number): TryWithPolicy {
        return this.with({
            retryIntervalMsecs: Math.max(0, retryIntervalMsecs)
        });
    }

    maxRetryIntervalMsecs(maxRetryIntervalMsecs: number): TryWithPolicy {
        return this.with({
            maxRetryIntervalMsecs: Math.max(0, maxRetryIntervalMsecs)
        });
    }

    maxElapsedMsecs(maxElapsedMsecs: number | undefined): TryWithPolicy {
        return this.with({
            maxElapsedMsecs: maxElapsedMsecs === undefined
                ? undefined
                : Math.max(0, maxElapsedMsecs)
        });
    }

    backoffFactor(backoffFactor: number): TryWithPolicy {
        return this.with({
            backoffFactor: Math.max(1, backoffFactor)
        });
    }

    jitterRatio(jitterRatio: number): TryWithPolicy {
        return this.with({
            jitterRatio: Math.max(0, Math.min(1, jitterRatio))
        });
    }

    retryIf(retryIf: TryWithRetryPredicate): TryWithPolicy {
        return this.with({ retryIf });
    }

    onRetry(onRetry: TryWithRetryObserver): TryWithPolicy {
        return this.with({ onRetry });
    }

    waitBeforeRetry(waitBeforeRetry: TryWithRetryWait): TryWithPolicy {
        return this.with({ waitBeforeRetry });
    }

    async run<T>(handler: () => T | Promise<T>): Promise<T> {
        const startedAtMsecs = this.dependencies.nowEpochMs();
        let attempt = 0;

        while (true) {
            attempt += 1;

            try {
                return await handler();
            }
            catch (error) {
                const elapsedMsecs = this.dependencies.nowEpochMs() - startedAtMsecs;
                const context = this.toRetryContext(attempt, elapsedMsecs, error);

                await this.waitForNextAttempt(context);
            }
        }
    }

    private async waitForNextAttempt(context: TryWithRetryContext): Promise<void> {
        if (context.attempt >= this.options.maxAttempts) {
            throw this.toExhaustedError(context, context.error);
        }

        if (this.hasElapsedBudgetBeenExhausted(context.elapsedMsecs)) {
            throw this.toExhaustedError(context, context.error);
        }

        const shouldRetry = await this.options.retryIf(context.error, context);
        if (!shouldRetry) {
            throw context.error;
        }

        const randomUnit = this.dependencies.randomUnit();
        const delayMsecs = computeRetryDelayMsecs({
            attempt: context.attempt,
            baseMsecs: this.options.retryIntervalMsecs,
            maxMsecs: this.options.maxRetryIntervalMsecs,
            factor: this.options.backoffFactor,
            jitterRatio: this.options.jitterRatio,
            randomUnit
        });
        if (
            this.options.maxElapsedMsecs !== undefined &&
            context.elapsedMsecs + delayMsecs >
                this.options.maxElapsedMsecs
        ) {
            throw this.toExhaustedError(context, context.error);
        }

        const scheduledContext: TryWithRetryScheduledContext = {
            ...context,
            delayMsecs,
            nextAttempt: context.attempt + 1
        };
        await this.options.onRetry?.(scheduledContext);
        if (this.options.waitBeforeRetry) {
            await this.options.waitBeforeRetry(scheduledContext);
        }
        else {
            await this.dependencies.wait(delayMsecs);
        }
    }

    private with(options: Partial<TryWithPolicyOptions>): TryWithPolicy {
        return new TryWithPolicy({
            ...this.options,
            ...options
        }, this.dependencies);
    }

    private toRetryContext(
        attempt: number,
        elapsedMsecs: number,
        error: unknown
    ): TryWithRetryContext {
        return {
            label: this.options.label,
            attempt,
            maxAttempts: this.options.maxAttempts,
            elapsedMsecs,
            error
        };
    }

    private hasElapsedBudgetBeenExhausted(elapsedMsecs: number): boolean {
        return this.options.maxElapsedMsecs !== undefined &&
            elapsedMsecs >= this.options.maxElapsedMsecs;
    }

    private toExhaustedError(
        context: TryWithRetryContext,
        cause: unknown
    ): TryWithExhaustedError {
        const label = this.options.label ? ` for ${this.options.label}` : '';
        return new TryWithExhaustedError(
            `Retry attempts exhausted${label} after ${context.attempt} attempts`,
            context,
            { cause }
        );
    }
}

export const RetryPolicies = {
    optimisticCommit(label: string = 'optimistic-commit'): TryWithPolicy {
        return TryWithPolicy.defaults()
            .label(label)
            .maxAttempts(10)
            .retryIntervalMsecs(10)
            .maxRetryIntervalMsecs(50)
            .maxElapsedMsecs(500)
            .jitterRatio(0)
            .retryIf((error) => error instanceof RetryableConflictError);
    }
};

export function tryWithPolicy<T>(
    handler: () => T | Promise<T>,
    policy: TryWithPolicy = TryWithPolicy.defaults()
): Promise<T> {
    return policy.run(handler);
}

function sleep(delayMsecs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMsecs);
    });
}

export function tryWith<T>(input: TryWithInput<T>): Promise<T> {
    const policy = TryWithPolicy.defaults()
        .retryIntervalMsecs(input.retryIntervalMsecs)
        .maxAttempts(Math.ceil(input.maxAttempts))
        .maxRetryIntervalMsecs(input.maxRetryIntervalMsecs)
        .backoffFactor(2)
        .jitterRatio(0.2);
    return policy.run(input.handler);
}

export function tryRunInIntervals<T>(input: TryRunInIntervalsInput<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        new PeriodicRetryCycle(input, {
            schedule: (delayMsecs, elapsed) => setTimeout(elapsed, delayMsecs),
            cancel: (timer) => clearTimeout(timer)
        }, { resolve, reject }).start();
    });
}

interface PeriodicRetryWait {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly completion: PeriodicRetryCycle.Result<void>;
}

namespace PeriodicRetryCycle {
    export interface Result<T> {
        readonly resolve: (value: T) => void;
        readonly reject: (reason: unknown) => void;
    }

    export interface Dependencies {
        /** The host registers a deferred callback and returns before it can run. */
        readonly schedule: (delayMsecs: number, elapsed: () => void) => ReturnType<typeof setTimeout>;
        readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
    }
}

class PeriodicRetryCycle<T> {
    private readonly input: TryRunInIntervalsInput<T>;
    private readonly dependencies: PeriodicRetryCycle.Dependencies;
    private readonly policy: TryWithPolicy;
    private readonly first: PeriodicRetryCycle.Result<T>;
    private pendingWait: PeriodicRetryWait | undefined;
    private stopped = false;
    private readonly onAbort = () => this.stop();

    constructor(
        input: TryRunInIntervalsInput<T>,
        dependencies: PeriodicRetryCycle.Dependencies,
        first: PeriodicRetryCycle.Result<T>
    ) {
        this.first = first;
        this.input = input;
        this.dependencies = dependencies;
        this.policy = TryWithPolicy.defaults()
            .retryIntervalMsecs(input.retryIntervalMsecs)
            .maxAttempts(Math.ceil(input.maxAttempts))
            .maxRetryIntervalMsecs(20_000)
            .backoffFactor(2)
            .jitterRatio(0.2)
            .retryIf(() => !this.stopped)
            .waitBeforeRetry((context) => this.wait(context.delayMsecs));
    }

    start(): void {
        if (this.input.signal?.aborted) {
            this.stop();
        }
        else {
            this.input.signal?.addEventListener('abort', this.onAbort, { once: true });
            void this.runCycle();
        }
    }

    private async runCycle(): Promise<void> {
        if (this.stopped) {
            return;
        }
        try {
            const result = await this.policy.run(() => {
                if (this.stopped) {
                    throw this.input.signal?.reason;
                }
                return this.input.handler();
            });
            if (this.stopped) {
                return;
            }
            this.first.resolve(result);
            await this.wait(this.input.intervalMsecs);
            void this.runCycle();
        }
        catch (error) {
            this.finish(error);
        }
    }

    private wait(delayMsecs: number): Promise<void> {
        if (this.stopped) {
            return Promise.reject(this.input.signal?.reason);
        }
        return new Promise<void>((resolve, reject) => {
            const completion: PeriodicRetryCycle.Result<void> = { resolve, reject };
            const timer = this.dependencies.schedule(delayMsecs, () => {
                if (this.pendingWait?.completion !== completion) {
                    return;
                }
                this.pendingWait = undefined;
                completion.resolve(undefined);
            });
            this.pendingWait = { timer, completion };
        });
    }

    private stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        const pending = this.pendingWait;
        this.pendingWait = undefined;
        if (pending) {
            try {
                this.dependencies.cancel(pending.timer);
            }
            catch {
                // A failed host cancellation leaves only an inert callback until its deadline.
            }
            pending.completion.reject(this.input.signal?.reason);
        }
        this.first.reject(this.input.signal?.reason);
        this.input.signal?.removeEventListener('abort', this.onAbort);
    }

    private finish(error: unknown): void {
        this.stopped = true;
        this.first.reject(error);
        this.input.signal?.removeEventListener('abort', this.onAbort);
    }
}

function computeRetryDelayMsecs(delay: RetryDelayInput): number {
    const raw = Math.min(delay.maxMsecs, delay.baseMsecs * Math.pow(delay.factor, Math.max(0, delay.attempt - 1)));
    const jitter = raw * Math.max(0, Math.min(1, delay.jitterRatio));
    const delta = (delay.randomUnit * 2 - 1) * jitter;
    return Math.max(0, Math.round(raw + delta));
}
