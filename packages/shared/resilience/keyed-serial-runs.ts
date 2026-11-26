/**
 * Runs the tasks of one key one at a time, in the order they were given; the tasks of different keys run side by
 * side. A task that fails gives its error to its own caller and does not stop its key. A key with nothing left to
 * run is forgotten, so what the runs keep is one promise per key that has a task waiting or running.
 */
export class KeyedSerialRuns<K> {
    /** Per key, a promise that settles, and never rejects, when the last task given for it has run. */
    private readonly tails = new Map<K, Promise<void>>();

    run(key: K, task: () => void | Promise<void>): Promise<void> {
        const ran = this.whenIdle(key).then(task);
        const tail = ran.then(ignoreOutcome, ignoreOutcome);
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        });
        return ran;
    }

    /** Settles when everything given for the key so far has run; at once for a key with nothing to run. */
    whenIdle(key: K): Promise<void> {
        return this.tails.get(key) ?? Promise.resolve();
    }

    /** The keys with a task waiting or running. */
    size(): number {
        return this.tails.size;
    }
}

function ignoreOutcome(): void {}
