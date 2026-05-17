export type AsyncCommandTimeoutEvent<TKey> = Readonly<{
    key: TKey;
    timeoutMs: number;
    startedAtEpochMs: number;
    timedOutAtEpochMs: number;
    reason: 'async-command-timeout';
}>;

export type AsyncCommandWatch<TResource, TKey> = Readonly<{
    key: TKey;
    resource: TResource;
    timeoutMs: number;
    isComplete: (resource: TResource) => boolean;
    onTimeout: (
        resource: TResource,
        event: AsyncCommandTimeoutEvent<TKey>,
    ) => void | Promise<void>;
    onError?: (
        error: unknown,
        resource: TResource,
        event: AsyncCommandTimeoutEvent<TKey>,
    ) => void;
}>;

type PendingAsyncCommand<TResource> = Readonly<{
    resource: TResource;
    timeout: ReturnType<typeof setTimeout>;
}>;

export class AsyncCommand<TKey, TResource> {
    private readonly pending = new Map<TKey, PendingAsyncCommand<TResource>>();

    public watch(input: AsyncCommandWatch<TResource, TKey>): boolean {
        if (input.timeoutMs <= 0 || input.isComplete(input.resource)) {
            return false;
        }

        this.cancel(input.key);

        const startedAtEpochMs = Date.now();
        const timeout = setTimeout(
            () => this.handleTimeout(input, startedAtEpochMs),
            input.timeoutMs,
        );

        this.pending.set(input.key, {
            resource: input.resource,
            timeout,
        });

        return true;
    }

    public complete(key: TKey): boolean {
        return this.cancel(key);
    }

    public cancel(key: TKey): boolean {
        const pending = this.pending.get(key);
        if (!pending) {
            return false;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(key);
        return true;
    }

    public cancelAll(): void {
        for (const key of this.pending.keys()) {
            this.cancel(key);
        }
    }

    public has(key: TKey): boolean {
        return this.pending.has(key);
    }

    private handleTimeout(
        input: AsyncCommandWatch<TResource, TKey>,
        startedAtEpochMs: number,
    ): void {
        const pending = this.pending.get(input.key);
        if (!pending || pending.resource !== input.resource) {
            return;
        }

        this.pending.delete(input.key);

        if (input.isComplete(input.resource)) {
            return;
        }

        const event: AsyncCommandTimeoutEvent<TKey> = {
            key: input.key,
            timeoutMs: input.timeoutMs,
            startedAtEpochMs,
            timedOutAtEpochMs: Date.now(),
            reason: 'async-command-timeout',
        };

        void Promise.resolve()
            .then(() => input.onTimeout(input.resource, event))
            .catch((error) => input.onError?.(error, input.resource, event));
    }
}
