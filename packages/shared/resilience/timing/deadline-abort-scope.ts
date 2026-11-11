export namespace DeadlineAbortScope {
    export interface Input<Reason> {
        readonly parentSignal: AbortSignal | undefined;
        /** Absent: no deadline. Armed only while the scope is not already aborted. */
        readonly timeoutMs: number | undefined;
        readonly toParentReason: (parentSignal: AbortSignal) => Reason;
        readonly toTimeoutReason: () => Reason;
    }

    export type Origin = 'parent' | 'timeout' | 'caller';
}

export class DeadlineAbortScope<Reason> {
    readonly #controller = new AbortController();
    readonly #parentSignal: AbortSignal | undefined;
    readonly #toParentReason: (parentSignal: AbortSignal) => Reason;
    #timeout: ReturnType<typeof setTimeout> | undefined;
    #origin: DeadlineAbortScope.Origin | undefined;
    #deadlineReached = false;

    constructor(input: DeadlineAbortScope.Input<Reason>) {
        this.#parentSignal = input.parentSignal;
        this.#toParentReason = input.toParentReason;
        if (input.parentSignal?.aborted) {
            this.#abortFromParent();
        }
        else {
            input.parentSignal?.addEventListener('abort', this.#abortFromParent, { once: true });
        }
        if (input.timeoutMs !== undefined && !this.signal.aborted) {
            this.#timeout = setTimeout(() => {
                this.#timeout = undefined;
                this.#deadlineReached = true;
                this.#abortFrom('timeout', input.toTimeoutReason());
            }, input.timeoutMs);
        }
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    origin(): DeadlineAbortScope.Origin | undefined {
        return this.#origin;
    }

    deadlineReached(): boolean {
        return this.#deadlineReached;
    }

    abort(reason: Reason): void {
        this.#abortFrom('caller', reason);
    }

    cleanup(): void {
        clearTimeout(this.#timeout);
        this.#timeout = undefined;
        this.#parentSignal?.removeEventListener('abort', this.#abortFromParent);
    }

    #abortFromParent = (): void => {
        if (this.#parentSignal !== undefined) {
            this.#abortFrom('parent', this.#toParentReason(this.#parentSignal));
        }
    };

    #abortFrom(origin: DeadlineAbortScope.Origin, reason: Reason): void {
        if (!this.signal.aborted) {
            this.#origin = origin;
            this.#controller.abort(reason);
        }
    }
}
