import { BoundedConcurrencyAdmission } from './bounded-concurrency-admission.ts';

export namespace ExclusionKeyedAdmission {
    export interface Config {
        readonly maxConcurrent: number;
    }
}

interface KeyedRun {
    readonly exclusionKey: string;
    /** Resolves once the run settles either way; never rejects. */
    readonly completion: Promise<void>;
}

/**
 * Admits runs with at most the bound in flight. An exclusion key is a colon-separated path: a keyed run first waits
 * until every earlier run whose key equals its own, is a path prefix of it, or has its key as one has settled, and
 * only then waits for a slot, so a run that waits holds none. A scope-wide key thereby orders against every key inside
 * that scope. A run without a key waits only for a slot, and a failed run releases the runs behind it like a settled
 * one.
 */
export class ExclusionKeyedAdmission {
    private readonly slots: BoundedConcurrencyAdmission;
    private readonly unsettled = new Set<KeyedRun>();

    constructor(config: ExclusionKeyedAdmission.Config) {
        this.slots = new BoundedConcurrencyAdmission(config);
    }

    admit<T>(exclusionKey: string | undefined, run: () => Promise<T>): Promise<T> {
        if (exclusionKey === undefined) {
            return this.slots.admit(run);
        }
        const predecessors = [...this.unsettled]
            .filter((earlier) => isOverlappingExclusionKey(earlier.exclusionKey, exclusionKey))
            .map((earlier) => earlier.completion);
        const result = predecessors.length === 0
            ? this.slots.admit(run)
            : Promise.all(predecessors).then(() => this.slots.admit(run));
        const keyed: KeyedRun = { exclusionKey, completion: result.then(() => undefined, () => undefined) };
        this.unsettled.add(keyed);
        void keyed.completion.then(() => this.unsettled.delete(keyed));
        return result;
    }
}

function isOverlappingExclusionKey(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}
