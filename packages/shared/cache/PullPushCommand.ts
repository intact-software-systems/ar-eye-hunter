import type { CircuitBreaker, RateLimiter } from '../resilience/Resilience.ts';
import { Command, NullValueError } from './Command.ts';

export type PullSupplier<T> = (
    signal?: AbortSignal,
) => T | Promise<T>;

export type PushConsumer<TPulled, TPushed> = (
    value: TPulled,
    signal?: AbortSignal,
) => TPushed | Promise<TPushed>;

export type PullPushCommandResult<TPulled, TPushed> = Readonly<{
    pulled: TPulled;
    pushed: TPushed;
}>;

export type PullPushFallbackSupplier<TPulled, TPushed> = (
    error: unknown,
    pulled: TPulled | undefined,
) =>
    | PullPushCommandResult<TPulled, TPushed>
    | Promise<PullPushCommandResult<TPulled, TPushed>>;

export interface PullPushCommandHooks<TPulled, TPushed> {
    onSubscribe?: () => void;
    onPullSuccess?: (value: TPulled) => void;
    onPushSuccess?: (value: TPushed, pulled: TPulled) => void;
    onSuccess?: (value: PullPushCommandResult<TPulled, TPushed>) => void;
    onFallback?: (
        value: PullPushCommandResult<TPulled, TPushed>,
        cause: unknown,
        pulled: TPulled | undefined,
    ) => void;
    onError?: (error: unknown, pulled: TPulled | undefined) => void;
    onComplete?: () => void;
    onAttemptError?: (
        error: unknown,
        attempt: number,
        pulled: TPulled | undefined,
    ) => void;
}

export interface PullPushCommandOptions<TPulled, TPushed> {
    maxAttempts?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    errorOnNullPull?: boolean;
    errorOnNullPush?: boolean;
    fallback?: PullPushFallbackSupplier<TPulled, TPushed>;
    circuitBreaker?: CircuitBreaker;
    rateLimiter?: RateLimiter;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    hooks?: PullPushCommandHooks<TPulled, TPushed>;
}

export class PullPushCommand<TPulled, TPushed> {
    private lastPulled: TPulled | undefined;
    private readonly command: Command<PullPushCommandResult<TPulled, TPushed>>;

    public constructor(
        pull: PullSupplier<TPulled>,
        push: PushConsumer<TPulled, TPushed>,
        options: PullPushCommandOptions<TPulled, TPushed> = {},
    ) {
        if (!pull) {
            throw new Error('pull is required');
        }
        if (!push) {
            throw new Error('push is required');
        }

        const fallback = options.fallback;
        this.command = new Command<PullPushCommandResult<TPulled, TPushed>>(
            async (signal) => {
                this.lastPulled = undefined;

                const pulled = await pull(signal);
                if (
                    (pulled === undefined || pulled === null) &&
                    (options.errorOnNullPull ?? true)
                ) {
                    throw new NullValueError('Pull returned null or undefined');
                }

                this.lastPulled = pulled as TPulled;
                options.hooks?.onPullSuccess?.(this.lastPulled);

                const pushed = await push(this.lastPulled, signal);
                if (
                    (pushed === undefined || pushed === null) &&
                    (options.errorOnNullPush ?? false)
                ) {
                    throw new NullValueError('Push returned null or undefined');
                }

                options.hooks?.onPushSuccess?.(pushed as TPushed, this.lastPulled);

                return {
                    pulled: this.lastPulled,
                    pushed: pushed as TPushed,
                };
            },
            {
                maxAttempts: options.maxAttempts,
                signal: options.signal,
                timeoutMs: options.timeoutMs,
                errorOnNull: true,
                fallback: fallback
                    ? (error) => fallback(error, this.lastPulled)
                    : undefined,
                circuitBreaker: options.circuitBreaker,
                rateLimiter: options.rateLimiter,
                shouldRetry: options.shouldRetry,
                hooks: {
                    onSubscribe: options.hooks?.onSubscribe,
                    onSuccess: options.hooks?.onSuccess,
                    onFallback: (value, cause) =>
                        options.hooks?.onFallback?.(
                            value,
                            cause,
                            this.lastPulled,
                        ),
                    onError: (error) =>
                        options.hooks?.onError?.(error, this.lastPulled),
                    onComplete: options.hooks?.onComplete,
                    onAttemptError: (error, attempt) =>
                        options.hooks?.onAttemptError?.(
                            error,
                            attempt,
                            this.lastPulled,
                        ),
                },
            },
        );
    }

    public cancel(): void {
        this.command.cancel();
    }

    public isCancelled(): boolean {
        return this.command.isCancelled();
    }

    public run(): Promise<PullPushCommandResult<TPulled, TPushed>> {
        return this.command.run();
    }
}
