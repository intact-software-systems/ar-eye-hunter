export namespace SingleFlight {
    export interface Flight<V> {
        readonly result: Promise<V>;
        /** Resolves once the result settles either way; never rejects. */
        readonly completion: Promise<void>;
    }
}

/** One flight per key: a call for a key already in flight joins that promise; a settled flight is forgotten. */
export class SingleFlight<K, V> {
    private readonly inFlight = new Map<K, SingleFlight.Flight<V>>();

    run(key: K, start: () => Promise<V>): Promise<V> {
        const running = this.inFlight.get(key);
        if (running !== undefined) {
            return running.result;
        }
        const { promise: result, resolve, reject } = Promise.withResolvers<V>();
        const forget = (): void => {
            if (this.inFlight.get(key)?.result === result) {
                this.inFlight.delete(key);
            }
        };
        this.inFlight.set(key, { result, completion: result.then(forget, forget) });
        try {
            // Registration precedes start because synchronous callbacks may join, clear, or replace this flight.
            resolve(start());
        }
        catch (error) {
            forget();
            reject(error);
            throw error;
        }
        return result;
    }

    isInFlight(key: K): boolean {
        return this.inFlight.has(key);
    }

    /** The completion of every flight in progress: each resolves once its flight settles and never rejects. */
    completions(): readonly Promise<void>[] {
        return [...this.inFlight.values()].map((flight) => flight.completion);
    }

    /** Forgets every flight; each keeps running, and a new call for its key starts another. */
    clear(): void {
        this.inFlight.clear();
    }
}
