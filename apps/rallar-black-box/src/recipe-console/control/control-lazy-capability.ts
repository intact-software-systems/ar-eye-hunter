export type ControlLazyGeneration = symbol;

export type ControlLazyCapability<Value> = Readonly<{
    generation: ControlLazyGeneration;
    signal: AbortSignal;
    load(): Promise<Value>;
}>;

export type ControlLazyCapabilityOptions<Value> = Readonly<{
    signal: AbortSignal;
    load(signal: AbortSignal): Promise<Value>;
}>;

export function createControlLazyCapability<Value>(
    options: ControlLazyCapabilityOptions<Value>
): ControlLazyCapability<Value> {
    const generation = Symbol('control-lazy-generation');
    let cachedLoad: Promise<Value> | undefined;

    return {
        generation,
        signal: options.signal,
        load() {
            if (options.signal.aborted) {
                return Promise.reject(controlAbortError(options.signal));
            }
            if (!cachedLoad) {
                let resolveCached!: (value: Value | PromiseLike<Value>) => void;
                let rejectCached!: (reason?: unknown) => void;
                cachedLoad = new Promise<Value>((resolve, reject) => {
                    resolveCached = resolve;
                    rejectCached = reject;
                });
                let loading: Promise<Value>;
                try {
                    assertControlContextActive(options.signal);
                    loading = options.load(options.signal);
                }
                catch (error) {
                    const failedLoad = cachedLoad;
                    rejectCached(error);
                    if (!options.signal.aborted) {
                        cachedLoad = undefined;
                    }
                    return failedLoad;
                }
                settleWithinControlContext(loading, options.signal)
                    .then((value) => {
                        try {
                            assertControlContextActive(options.signal);
                            resolveCached(value);
                        }
                        catch (error) {
                            rejectCached(error);
                        }
                    }, (error) => {
                        if (!options.signal.aborted) {
                            cachedLoad = undefined;
                        }
                        rejectCached(error);
                    });
            }
            return cachedLoad;
        }
    };
}

function settleWithinControlContext<Value>(
    pending: Promise<Value>,
    signal: AbortSignal
): Promise<Value> {
    if (signal.aborted) {
        return Promise.reject(controlAbortError(signal));
    }
    return new Promise<Value>((resolve, reject) => {
        const onAbort = () => finish(() => reject(controlAbortError(signal)));
        const finish = (settle: () => void) => {
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error))
        );
    });
}

function assertControlContextActive(signal: AbortSignal): void {
    if (signal.aborted) {
        throw controlAbortError(signal);
    }
}

function controlAbortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (
        reason instanceof Error &&
        reason.name === 'AbortError'
    ) {
        return reason;
    }
    return new DOMException(
        'The control connection is no longer current.',
        'AbortError'
    );
}
