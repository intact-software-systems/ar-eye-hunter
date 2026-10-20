import { BoundedConcurrencyAdmission } from './bounded-concurrency-admission.ts';

export namespace ExclusionKeyedAdmission {
    export interface Config {
        readonly maxConcurrent: number;
        /**
         * Whether a keyed run that the settlement of an earlier run with the same key released takes a freed slot ahead
         * of every run waiting in turn; otherwise all wait in turn. A keyed run with no unsettled predecessor, or one
         * whose last predecessor had a prefix or extension of its key, waits in turn, so one settlement prefers at most
         * the runs of its own key. A continuously fed same-key chain therefore holds one slot for as long as it is fed,
         * and with as many such chains as slots, runs waiting in turn wait until one chain drains.
         */
        readonly releasedKeyedRunsFirst: boolean;
    }
}

interface KeyedRun {
    readonly exclusionKey: string;
    /** The later runs that wait for this one, among others, to settle. */
    readonly successors: KeyedRun[];
    unsettledPredecessors: number;
    readonly waitForSlot: (priority: BoundedConcurrencyAdmission.Priority) => void;
}

/**
 * Admits runs with at most the bound in flight. An exclusion key is a colon-separated path: a keyed run first waits
 * until every earlier run whose key equals its own, is a path prefix of it, or has its key as one has settled, and
 * only then waits for a slot, so a run that waits holds none. A scope-wide key thereby orders against every key inside
 * that scope. A run without a key waits only for a slot, and a failed run releases the runs behind it like a settled
 * one. A settling run lines up the runs it released before its slot frees, so a released run of the same key can take
 * that slot; a keyed run that waited on no predecessor, or that a different key released, asks for its slot in turn.
 */
export class ExclusionKeyedAdmission {
    private readonly slots: BoundedConcurrencyAdmission;
    private readonly releasedRunPriority: BoundedConcurrencyAdmission.Priority;
    private readonly unsettled = new Set<KeyedRun>();

    constructor(config: ExclusionKeyedAdmission.Config) {
        this.slots = new BoundedConcurrencyAdmission({ maxConcurrent: config.maxConcurrent });
        this.releasedRunPriority = config.releasedKeyedRunsFirst ? 'preferred' : 'in-turn';
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
                waitForSlot: (priority) => {
                    this.slots.admit(() => this.runKeyed(keyed, run), priority).then(resolve, reject);
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
                keyed.waitForSlot('in-turn');
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
                    successor.waitForSlot(
                        successor.exclusionKey === keyed.exclusionKey ? this.releasedRunPriority : 'in-turn'
                    );
                }
            }
        }
    }
}

function isOverlappingExclusionKey(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}
