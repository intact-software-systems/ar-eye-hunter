import { BoundedConcurrencyAdmission } from './bounded-concurrency-admission.ts';

export namespace ExclusionKeyedAdmission {
    export interface Config {
        readonly maxConcurrent: number;
        /** Whether a keyed run takes a freed slot ahead of every waiting keyless run; otherwise all wait in turn. */
        readonly keyedRunsFirst: boolean;
    }
}

interface KeyedRun {
    readonly exclusionKey: string;
    /** The later runs that wait for this one, among others, to settle. */
    readonly successors: KeyedRun[];
    unsettledPredecessors: number;
    readonly waitForSlot: () => void;
}

/**
 * Admits runs with at most the bound in flight. An exclusion key is a colon-separated path: a keyed run first waits
 * until every earlier run whose key equals its own, is a path prefix of it, or has its key as one has settled, and
 * only then waits for a slot, so a run that waits holds none. A scope-wide key thereby orders against every key inside
 * that scope. A run without a key waits only for a slot, and a failed run releases the runs behind it like a settled
 * one. A settling run lines up the runs it released before its slot frees, so a released keyed run can take that slot.
 */
export class ExclusionKeyedAdmission {
    private readonly slots: BoundedConcurrencyAdmission;
    private readonly keyedPriority: BoundedConcurrencyAdmission.Priority;
    private readonly unsettled = new Set<KeyedRun>();

    constructor(config: ExclusionKeyedAdmission.Config) {
        this.slots = new BoundedConcurrencyAdmission({ maxConcurrent: config.maxConcurrent });
        this.keyedPriority = config.keyedRunsFirst ? 'preferred' : 'in-turn';
    }

    admit<T>(exclusionKey: string | undefined, run: () => Promise<T>): Promise<T> {
        if (exclusionKey === undefined) {
            return this.slots.admit(run);
        }
        return new Promise<T>((resolve, reject) => {
            const keyed: KeyedRun = {
                exclusionKey,
                successors: [],
                unsettledPredecessors: 0,
                waitForSlot: () => {
                    this.slots.admit(() => this.runKeyed(keyed, run), this.keyedPriority).then(resolve, reject);
                }
            };
            for (const earlier of this.unsettled) {
                if (isOverlappingExclusionKey(earlier.exclusionKey, exclusionKey)) {
                    earlier.successors.push(keyed);
                    keyed.unsettledPredecessors += 1;
                }
            }
            this.unsettled.add(keyed);
            if (keyed.unsettledPredecessors === 0) {
                keyed.waitForSlot();
            }
        });
    }

    private async runKeyed<T>(keyed: KeyedRun, run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        }
        finally {
            this.unsettled.delete(keyed);
            for (const successor of keyed.successors) {
                successor.unsettledPredecessors -= 1;
                if (successor.unsettledPredecessors === 0) {
                    successor.waitForSlot();
                }
            }
        }
    }
}

function isOverlappingExclusionKey(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}
