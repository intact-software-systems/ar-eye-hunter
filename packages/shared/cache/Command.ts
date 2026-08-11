import { CircuitBreaker, RateLimiter } from '../resilience/Resilience.ts';

export type LoanedValueSupplier<T> = (
    signal?: AbortSignal,
) => T | Promise<T>;
export type FallbackSupplier<T> = (error: unknown) => T | Promise<T>;

export interface CommandHooks<T> {
    onSubscribe?: () => void;
    onSuccess?: (value: T) => void;
    onFallback?: (value: T, cause: unknown) => void;
    onError?: (error: unknown) => void;
    onComplete?: () => void;
    onAttemptError?: (error: unknown, attempt: number) => void;
}

export interface CommandOptions<T> {
    maxAttempts?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    errorOnNull?: boolean;
    fallback?: FallbackSupplier<T>;
    circuitBreaker?: CircuitBreaker;
    rateLimiter?: RateLimiter;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    hooks?: CommandHooks<T>;
}

export class CircuitBreakerOpenError extends Error {
    public constructor(message = 'Circuit breaker is open') {
        super(message);
        this.name = 'CircuitBreakerOpenError';
    }
}

export class RateLimitExceededError extends Error {
    public constructor(message = 'Rate limit violated') {
        super(message);
        this.name = 'RateLimitExceededError';
    }
}

export class NullValueError extends Error {
    public constructor(message = 'Supplier returned null or undefined') {
        super(message);
        this.name = 'NullValueError';
    }
}

export class CommandCancelledError extends Error {
    public constructor(message = 'Command cancelled') {
        super(message);
        this.name = 'CommandCancelledError';
    }
}

export class CommandTimedOutError extends Error {
    public constructor(timeoutMs: number) {
        super(`Command timed out after ${timeoutMs} ms`);
        this.name = 'CommandTimedOutError';
    }
}

export class Command<T> {
    private cancelled = false;
    private activeAttemptController: AbortController | undefined;

    private readonly supplier: LoanedValueSupplier<T>;
    private readonly options: CommandOptions<T>;

    public constructor(
        supplier: LoanedValueSupplier<T>,
        options: CommandOptions<T> = {},
    ) {
        this.supplier = supplier;
        this.options = options;
        if (!supplier) {
            throw new Error('supplier is required');
        }
    }

    public cancel(): void {
        this.cancelled = true;
        this.activeAttemptController?.abort(new CommandCancelledError());
    }

    public isCancelled(): boolean {
        return this.cancelled;
    }

    public async run(): Promise<T> {
        const {
            maxAttempts = 1,
            signal,
            timeoutMs,
            errorOnNull = true,
            fallback,
            circuitBreaker,
            rateLimiter,
            shouldRetry = () => true,
            hooks,
        } = this.options;

        if (this.cancelled) {
            throw new CommandCancelledError();
        }
        if (signal?.aborted) {
            throw Command.toCommandCancelledError(signal.reason);
        }

        const circuitAllowed = circuitBreaker?.allow() ?? true;
        const rateAllowed = rateLimiter?.allow() ?? true;

        if (!circuitAllowed) {
            const error = new CircuitBreakerOpenError();
            hooks?.onError?.(error);
            throw error;
        }

        if (!rateAllowed) {
            const error = new RateLimitExceededError();
            hooks?.onError?.(error);
            throw error;
        }

        hooks?.onSubscribe?.();

        let lastError: unknown;

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (this.cancelled) {
                    throw new CommandCancelledError();
                }
                if (signal?.aborted) {
                    throw Command.toCommandCancelledError(signal.reason);
                }

                try {
                    const value = await this.executeOnce(
                        signal,
                        timeoutMs,
                        errorOnNull,
                    );
                    hooks?.onSuccess?.(value);
                    circuitBreaker?.success();
                    hooks?.onComplete?.();
                    return value;
                } catch (error) {
                    if (error instanceof CommandCancelledError) {
                        throw error;
                    }

                    lastError = error;
                    hooks?.onAttemptError?.(error, attempt);

                    const hasAttemptsLeft = attempt < maxAttempts;
                    const retry = hasAttemptsLeft && shouldRetry(error, attempt);

                    if (!retry) {
                        break;
                    }
                }
            }

            if (fallback) {
                const fallbackValue = await fallback(lastError);

                if (
                    (fallbackValue === undefined || fallbackValue === null) &&
                    errorOnNull
                ) {
                    throw new NullValueError('Fallback returned null or undefined');
                }

                hooks?.onFallback?.(fallbackValue as T, lastError);
                circuitBreaker?.success();
                hooks?.onComplete?.();
                return fallbackValue as T;
            }

            throw lastError;
        } catch (error) {
            if (
                !(error instanceof CircuitBreakerOpenError) &&
                !(error instanceof RateLimitExceededError) &&
                !(error instanceof CommandCancelledError)
            ) {
                circuitBreaker?.failure();
            }
            hooks?.onError?.(error);
            throw error;
        }
    }

    private async executeOnce(
        parentSignal: AbortSignal | undefined,
        timeoutMs: number | undefined,
        errorOnNull: boolean,
    ): Promise<T> {
        const attempt = this.createAttemptSignal(parentSignal);
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;

        if (timeoutMs !== undefined) {
            timeoutHandle = setTimeout(() => {
                attempt.controller.abort(new CommandTimedOutError(timeoutMs));
            }, timeoutMs);
        }

        this.activeAttemptController = attempt.controller;

        const operation = (async () => {
            try {
                const result = await this.supplier(attempt.signal);

                if ((result === undefined || result === null) && errorOnNull) {
                    throw new NullValueError();
                }

                return result as T;
            } catch (error) {
                if (attempt.signal.aborted && Command.isAbortError(error)) {
                    throw Command.toCommandAbortError(attempt.signal.reason);
                }

                throw error;
            }
        })();

        const abort = new Promise<T>((_, reject) => {
            abortListener = () =>
                reject(Command.toCommandAbortError(attempt.signal.reason));

            if (attempt.signal.aborted) {
                abortListener();
                return;
            }

            attempt.signal.addEventListener('abort', abortListener, { once: true });
        });

        try {
            return await Promise.race([operation, abort]);
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            if (abortListener !== undefined) {
                attempt.signal.removeEventListener('abort', abortListener);
            }
            attempt.cleanup();
            if (this.activeAttemptController === attempt.controller) {
                this.activeAttemptController = undefined;
            }
        }
    }

    private createAttemptSignal(
        parentSignal: AbortSignal | undefined,
    ): {
        controller: AbortController;
        signal: AbortSignal;
        cleanup: () => void;
    } {
        const controller = new AbortController();
        const abortFromParent = () => {
            controller.abort(Command.toCommandCancelledError(parentSignal?.reason));
        };

        if (this.cancelled) {
            controller.abort(new CommandCancelledError());
        } else if (parentSignal?.aborted) {
            abortFromParent();
        } else {
            parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        }

        return {
            controller,
            signal: controller.signal,
            cleanup: () =>
                parentSignal?.removeEventListener('abort', abortFromParent),
        };
    }

    private static toCommandAbortError(reason: unknown): Error {
        if (reason instanceof CommandTimedOutError) {
            return reason;
        }
        if (reason instanceof CommandCancelledError) {
            return reason;
        }

        return Command.toCommandCancelledError(reason);
    }

    private static toCommandCancelledError(
        reason: unknown,
    ): CommandCancelledError {
        if (reason instanceof CommandCancelledError) {
            return reason;
        }

        if (reason instanceof Error) {
            return new CommandCancelledError(reason.message);
        }

        if (typeof reason === 'string' && reason.length > 0) {
            return new CommandCancelledError(reason);
        }

        return new CommandCancelledError();
    }

    private static isAbortError(error: unknown): boolean {
        return error instanceof DOMException && error.name === 'AbortError';
    }
}
