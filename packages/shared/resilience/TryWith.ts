function backoffDelayMs(
    attempt: number,
    base: number,
    max: number = 20_000,
    jitter: number = 0.2,
): number {
    const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
    const j = raw * Math.max(0, Math.min(1, jitter));
    const delta = (Math.random() * 2 - 1) * j;

    return Math.max(0, Math.round(raw + delta));
}

export type TryWithRetryContext = Readonly<{
    label?: string;
    attempt: number;
    maxAttempts: number;
    elapsedMsecs: number;
    error: unknown;
}>;

export type TryWithRetryScheduledContext = TryWithRetryContext & Readonly<{
    delayMsecs: number;
    nextAttempt: number;
}>;

export type TryWithRetryPredicate = (
    error: unknown,
    context: TryWithRetryContext,
) => boolean | Promise<boolean>;

export type TryWithRetryObserver = (
    context: TryWithRetryScheduledContext,
) => void | Promise<void>;

type TryWithPolicyOptions = Readonly<{
    label?: string;
    maxAttempts: number;
    retryIntervalMsecs: number;
    maxRetryIntervalMsecs: number;
    maxElapsedMsecs?: number;
    backoffFactor: number;
    jitterRatio: number;
    retryIf: TryWithRetryPredicate;
    onRetry?: TryWithRetryObserver;
}>;

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
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.context = context;
        this.name = 'TryWithExhaustedError';
    }
}

export class TryWithPolicy {
    private readonly options: TryWithPolicyOptions;

    private constructor(
        options: TryWithPolicyOptions,
    ) {
        this.options = options;
    }

    static defaults(): TryWithPolicy {
        return new TryWithPolicy({
            maxAttempts: Number.MAX_SAFE_INTEGER,
            retryIntervalMsecs: 500,
            maxRetryIntervalMsecs: 20_000,
            backoffFactor: 2,
            jitterRatio: 0.2,
            retryIf: () => true,
        });
    }

    label(label: string): TryWithPolicy {
        return this.with({ label });
    }

    maxAttempts(maxAttempts: number): TryWithPolicy {
        return this.with({
            maxAttempts: Math.max(1, Math.floor(maxAttempts)),
        });
    }

    retryIntervalMsecs(retryIntervalMsecs: number): TryWithPolicy {
        return this.with({
            retryIntervalMsecs: Math.max(0, retryIntervalMsecs),
        });
    }

    initialDelayMsecs(retryIntervalMsecs: number): TryWithPolicy {
        return this.retryIntervalMsecs(retryIntervalMsecs);
    }

    maxRetryIntervalMsecs(maxRetryIntervalMsecs: number): TryWithPolicy {
        return this.with({
            maxRetryIntervalMsecs: Math.max(0, maxRetryIntervalMsecs),
        });
    }

    maxDelayMsecs(maxRetryIntervalMsecs: number): TryWithPolicy {
        return this.maxRetryIntervalMsecs(maxRetryIntervalMsecs);
    }

    maxElapsedMsecs(maxElapsedMsecs: number | undefined): TryWithPolicy {
        return this.with({
            maxElapsedMsecs: maxElapsedMsecs === undefined
                ? undefined
                : Math.max(0, maxElapsedMsecs),
        });
    }

    backoffFactor(backoffFactor: number): TryWithPolicy {
        return this.with({
            backoffFactor: Math.max(1, backoffFactor),
        });
    }

    jitterRatio(jitterRatio: number): TryWithPolicy {
        return this.with({
            jitterRatio: Math.max(0, Math.min(1, jitterRatio)),
        });
    }

    retryIf(retryIf: TryWithRetryPredicate): TryWithPolicy {
        return this.with({ retryIf });
    }

    onRetry(onRetry: TryWithRetryObserver): TryWithPolicy {
        return this.with({ onRetry });
    }

    async run<T>(handler: () => T | Promise<T>): Promise<T> {
        const startedAtMsecs = Date.now();
        let attempt = 0;

        while (true) {
            attempt += 1;

            try {
                return await handler();
            } catch (error) {
                const context = this.toRetryContext(
                    attempt,
                    startedAtMsecs,
                    error,
                );

                if (attempt >= this.options.maxAttempts) {
                    throw this.toExhaustedError(context, error);
                }

                if (this.hasElapsedBudgetBeenExhausted(context.elapsedMsecs)) {
                    throw this.toExhaustedError(context, error);
                }

                const shouldRetry = await this.options.retryIf(error, context);
                if (!shouldRetry) {
                    throw error;
                }

                const delayMsecs = this.toDelayMsecs(attempt);
                if (
                    this.options.maxElapsedMsecs !== undefined &&
                    context.elapsedMsecs + delayMsecs >
                    this.options.maxElapsedMsecs
                ) {
                    throw this.toExhaustedError(context, error);
                }

                const scheduledContext: TryWithRetryScheduledContext = {
                    ...context,
                    delayMsecs,
                    nextAttempt: attempt + 1,
                };
                await this.options.onRetry?.(scheduledContext);
                await sleep(delayMsecs);
            }
        }
    }

    private with(options: Partial<TryWithPolicyOptions>): TryWithPolicy {
        return new TryWithPolicy({
            ...this.options,
            ...options,
        });
    }

    private toRetryContext(
        attempt: number,
        startedAtMsecs: number,
        error: unknown,
    ): TryWithRetryContext {
        return {
            label: this.options.label,
            attempt,
            maxAttempts: this.options.maxAttempts,
            elapsedMsecs: Date.now() - startedAtMsecs,
            error,
        };
    }

    private hasElapsedBudgetBeenExhausted(elapsedMsecs: number): boolean {
        return this.options.maxElapsedMsecs !== undefined &&
            elapsedMsecs >= this.options.maxElapsedMsecs;
    }

    private toDelayMsecs(attempt: number): number {
        const raw = Math.min(
            this.options.maxRetryIntervalMsecs,
            this.options.retryIntervalMsecs *
            Math.pow(this.options.backoffFactor, Math.max(0, attempt - 1)),
        );
        const jitter = raw * this.options.jitterRatio;
        const delta = (Math.random() * 2 - 1) * jitter;
        return Math.max(0, Math.round(raw + delta));
    }

    private toExhaustedError(
        context: TryWithRetryContext,
        cause: unknown,
    ): TryWithExhaustedError {
        const label = this.options.label ? ` for ${this.options.label}` : '';
        return new TryWithExhaustedError(
            `Retry attempts exhausted${label} after ${context.attempt} attempts`,
            context,
            { cause },
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
    },
};

export function tryWithPolicy<T>(
    handler: () => T | Promise<T>,
    policy: TryWithPolicy = TryWithPolicy.defaults(),
): Promise<T> {
    return policy.run(handler);
}

function sleep(delayMsecs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMsecs);
    });
}

export function tryWith<T>(
    handler: () => T | Promise<T>,
    retryIntervalMsecs: number = 500,
    maxAttempts: number = Number.MAX_VALUE,
    maxRetryIntervalMsecs: number = 20_000,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const tryToExecute = async (
            currentRetryIntervalMsecs: number,
            attempts: number,
        ): Promise<void> => {
            try {
                resolve(await handler());
            } catch (_) {
                if (attempts >= maxAttempts) {
                    reject({ error: 'Unable to do it' });
                    return;
                }

                setTimeout(
                    () => {
                        void tryToExecute(
                            backoffDelayMs(attempts, retryIntervalMsecs, maxRetryIntervalMsecs),
                            attempts + 1,
                        );
                    },
                    currentRetryIntervalMsecs,
                );
            }
        };

        void tryToExecute(retryIntervalMsecs, 1);
    });
}

export function tryRunInIntervals<T>(
    handler: () => T | Promise<T>,
    intervalMsecs: number = 60000,
    retryIntervalMsecs: number = 10000,
    maxAttempts: number = Number.MAX_VALUE,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let stopped = false;

        const schedule = (
            delayMsecs: number,
            nextRetryIntervalMsecs: number,
            attempts: number,
        ) => {
            setTimeout(() => {
                void tryToExecute(nextRetryIntervalMsecs, attempts);
            }, delayMsecs);
        };

        const tryToExecute = async (
            currentRetryIntervalMsecs: number,
            attempts: number,
        ): Promise<void> => {
            if (stopped) {
                return;
            }

            try {
                const result = await handler();

                if (!settled) {
                    settled = true;
                    resolve(result);
                }

                schedule(intervalMsecs, retryIntervalMsecs, 1);
            } catch (_) {
                if (attempts >= maxAttempts) {
                    stopped = true;
                    if (!settled) {
                        reject({ error: 'Unable to do it' });
                    }
                    return;
                }

                schedule(
                    currentRetryIntervalMsecs,
                    backoffDelayMs(attempts, retryIntervalMsecs),
                    attempts + 1,
                );
            }
        };

        void tryToExecute(retryIntervalMsecs, 1);
    });
}
