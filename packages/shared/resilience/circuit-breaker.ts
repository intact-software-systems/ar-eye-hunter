import { Temporal } from '@js-temporal/polyfill';

import { Either } from './Either.ts';
import { AtomicLong, AtomicReference, SlidingWindowCounter } from './Resilience.ts';

function nowMs(): number {
    return Date.now();
}

export const CircuitBreakerState = {
    OPEN: 'OPEN',
    CLOSE: 'CLOSE',
    HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitBreakerState = (typeof CircuitBreakerState)[keyof typeof CircuitBreakerState];

export class CircuitBreakerPolicy {
    public readonly maxConsecutiveFailures: number;
    public readonly resetTimeout: Temporal.Duration;
    public readonly halfOpenTimeout: Temporal.Duration;
    public readonly slidingWindow: Temporal.Duration;

    constructor(
        maxConsecutiveFailures: number,
        resetTimeout: Temporal.Duration,
        halfOpenTimeout: Temporal.Duration,
        slidingWindow: Temporal.Duration,
    ) {
        this.maxConsecutiveFailures = maxConsecutiveFailures;
        this.resetTimeout = resetTimeout;
        this.halfOpenTimeout = halfOpenTimeout;
        this.slidingWindow = slidingWindow;
    }
}

export class CircuitBreaker {
    private static readonly RESET_VALUE = Number.MAX_SAFE_INTEGER;

    public readonly state: AtomicReference<CircuitBreakerState>;
    public readonly slidingWindow: SlidingWindowCounter;
    public readonly timestampOpen: AtomicLong;
    public readonly timestampHalfOpen: AtomicLong;
    public readonly policy: CircuitBreakerPolicy;

    constructor(
        state: AtomicReference<CircuitBreakerState>,
        slidingWindow: SlidingWindowCounter,
        timestampOpen: AtomicLong,
        timestampHalfOpen: AtomicLong,
        policy: CircuitBreakerPolicy,
    ) {
        this.state = state;
        this.slidingWindow = slidingWindow;
        this.timestampOpen = timestampOpen;
        this.timestampHalfOpen = timestampHalfOpen;
        this.policy = policy;
    }

    static create(policy: CircuitBreakerPolicy): CircuitBreaker {
        return new CircuitBreaker(
            new AtomicReference<CircuitBreakerState>(CircuitBreakerState.CLOSE),
            SlidingWindowCounter.init(
                policy.slidingWindow.total({ unit: 'milliseconds' }),
                Math.floor(policy.slidingWindow.total({ unit: 'milliseconds' }) / 10),
            ),
            new AtomicLong(CircuitBreaker.RESET_VALUE),
            new AtomicLong(CircuitBreaker.RESET_VALUE),
            policy,
        );
    }

    static async tryToExecute<T>(
        circuitBreaker: CircuitBreaker,
        supplier: () => Promise<T>,
        isSuccessful: (result: T) => boolean = () => true,
    ): Promise<Either<Error, T>> {
        try {
            if (!circuitBreaker.allow()) {
                return Either.ofLeft(new Error('Not allowed to execute'));
            }

            const value = await supplier();
            if (isSuccessful(value)) {
                circuitBreaker.success();
            } else {
                circuitBreaker.failure();
            }

            return Either.ofRight(value);
        } catch (e) {
            circuitBreaker.failure();
            return Either.ofLeft(e instanceof Error ? e : new Error(String(e)));
        }
    }

    static async tryToExecuteBooleanSupplier(
        circuitBreaker: CircuitBreaker,
        supplier: () => Promise<boolean>
    ): Promise<boolean> {
        try {
            if (!circuitBreaker.allow()) {
                return false;
            }

            const isSuccess = await supplier();

            if (isSuccess) {
                circuitBreaker.success();
            } else {
                circuitBreaker.failure();
            }

            return isSuccess;
        } catch (error) {
            circuitBreaker.failure();
            console.error('Execution failed:', error);
            return false;
        }
    }

    success(): CircuitBreaker {
        this.slidingWindow.reset();

        this.timestampOpen.set(CircuitBreaker.RESET_VALUE);
        this.timestampHalfOpen.set(CircuitBreaker.RESET_VALUE);
        this.state.set(CircuitBreakerState.CLOSE);

        return this;
    }

    failure(): CircuitBreaker {
        return this.failureCount(1);
    }

    failureCount(count: number): CircuitBreaker {
        this.slidingWindow.update(count);

        const sumInWindow = this.slidingWindow.sumInWindow();
        if (
            // if sum of failures in window > maximum allowed failures in window, then trip circuit OPEN
            sumInWindow > this.policy.maxConsecutiveFailures ||
            // the breaker is tripped again into the OPEN state for another full resetTimeout
            this.state.get() === CircuitBreakerState.HALF_OPEN
        ) {
            const previous = this.state.getAndSet(CircuitBreakerState.OPEN);
            if (previous !== CircuitBreakerState.OPEN) {
                // this thread set new state
                this.timestampOpen.set(nowMs());
                this.timestampHalfOpen.set(CircuitBreaker.RESET_VALUE);
            }
        }

        return this;
    }

    // Mutating update of circuit breaker
    allow(): boolean {
        if (this.state.get() === CircuitBreakerState.OPEN) {
            const timeSinceOpened = nowMs() - this.timestampOpen.get();

            if (timeSinceOpened > this.policy.resetTimeout.total({ unit: 'milliseconds' })) {
                const previous = this.state.getAndSet(CircuitBreakerState.HALF_OPEN);
                if (previous === CircuitBreakerState.OPEN) {
                    // This thread set circuit to half open and is allowed through
                    this.timestampHalfOpen.set(nowMs());
                    return true;
                }
            }
        } else if (this.state.get() === CircuitBreakerState.HALF_OPEN) {
            // check if state has been in half open too long
            const timeSinceHalfOpened = nowMs() - this.timestampHalfOpen.get();

            if (timeSinceHalfOpened > this.policy.halfOpenTimeout.total({ unit: 'milliseconds' })) {
                this.failureCount(1);
            }
        }

        return this.state.get() === CircuitBreakerState.CLOSE;
    }

    // Note: Non-mutating check of circuit breaker
    isAllowedThrough(): boolean {
        if (this.state.get() === CircuitBreakerState.OPEN) {
            const timeSinceOpened = nowMs() - this.timestampOpen.get();
            if (timeSinceOpened > this.policy.resetTimeout.total({ unit: 'milliseconds' })) {
                return true;
            }
        } else if (this.state.get() === CircuitBreakerState.HALF_OPEN) {
            const timeSinceHalfOpened = nowMs() - this.timestampHalfOpen.get();
            if (timeSinceHalfOpened > this.policy.halfOpenTimeout.total({ unit: 'milliseconds' })) {
                return true;
            }
        }

        return this.state.get() === CircuitBreakerState.CLOSE;
    }

    isOpen(): boolean {
        return this.state.get() === CircuitBreakerState.OPEN;
    }

    isHalfOpen(): boolean {
        return this.state.get() === CircuitBreakerState.HALF_OPEN;
    }

    isClosed(): boolean {
        return this.state.get() === CircuitBreakerState.CLOSE;
    }
}

export function toCircuitBreaker(
    maxConsecutiveFailures: number = 10,
    duration: Temporal.Duration = Temporal.Duration.from({ seconds: 10 })
): CircuitBreaker {
    return CircuitBreaker.create(
        new CircuitBreakerPolicy(
            maxConsecutiveFailures,
            duration,
            duration,
            duration
        )
    );
}
