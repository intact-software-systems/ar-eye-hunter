import { BoundedConcurrencyAdmission } from './bounded-concurrency-admission.ts';

export namespace ExclusionKeyedAdmission {
    export interface Config {
        readonly maxConcurrent: number;
        /**
         * Whether a keyed run that the settlement of an earlier run with the same key released, or a chain head, takes a
         * freed slot ahead of every run waiting in turn; otherwise all wait in turn. A chain head is a run behind which
         * a later run with its key, or an extension of it, waits; a run waiting in turn becomes one, and goes ahead, the
         * moment such a run attaches. A wider later run never promotes the narrower runs it waits behind, so a scope-wide
         * run arriving behind many runs inside its scope moves none of them ahead of the runs waiting in turn. A lone
         * keyed run with no unsettled predecessor, or one a different key released, waits in turn until then, so one
         * settlement prefers at most the runs of its own key and the chain heads among the runs it released. A
         * continuously fed chain therefore holds one slot for as long as it is fed, and with as many such chains as
         * slots, runs waiting in turn wait until one chain drains.
         */
        readonly keyedChainsFirst: boolean;
    }
}

interface KeyedRun {
    readonly exclusionKey: string;
    /** The later runs that wait for this one, among others, to settle. */
    readonly successors: KeyedRun[];
    unsettledPredecessors: number;
    /** A later run with this run's key, or an extension of it, waits behind it. */
    isChainHead: boolean;
    readonly waitForSlot: (priority: BoundedConcurrencyAdmission.Priority) => void;
    /** Moves the run ahead of the runs waiting in turn while it waits for its slot in turn; absent before it waits. */
    prefer: (() => void) | undefined;
}

/**
 * Admits runs with at most the bound in flight. An exclusion key is a colon-separated path: a keyed run first waits
 * until every earlier run whose key equals its own, is a path prefix of it, or has its key as one has settled, and
 * only then waits for a slot, so a run that waits holds none. A scope-wide key thereby orders against every key inside
 * that scope. A run without a key waits only for a slot, and a failed run releases the runs behind it like a settled
 * one. A settling run lines up the runs it released before its slot frees, so a released run of the same key can take
 * that slot; a keyed run that waited on no predecessor, or that a different key released, asks for its slot in turn
 * unless it is a chain head, and is moved ahead once a run with its key or an extension of it attaches behind it.
 */
export class ExclusionKeyedAdmission {
    private readonly slots: BoundedConcurrencyAdmission;
    private readonly keyedChainsFirst: boolean;
    private readonly unsettled = new Set<KeyedRun>();

    constructor(config: ExclusionKeyedAdmission.Config) {
        this.slots = new BoundedConcurrencyAdmission({ maxConcurrent: config.maxConcurrent });
        this.keyedChainsFirst = config.keyedChainsFirst;
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
                isChainHead: false,
                waitForSlot: (priority) => {
                    const admission = this.slots.admitPromotable(() => this.runKeyed(keyed, run), priority);
                    keyed.prefer = admission.prefer;
                    admission.result.then(resolve, reject);
                },
                prefer: undefined
            };
            for (const earlier of this.unsettled) {
                if (isOverlappingExclusionKey(earlier.exclusionKey, exclusionKey)) {
                    earlier.successors.push(keyed);
                    keyed.unsettledPredecessors += 1;
                    this.attachChainSuccessor(earlier, keyed);
                }
            }
            this.unsettled.add(keyed);
            if (keyed.unsettledPredecessors === 0) {
                keyed.waitForSlot('in-turn');
            }
        });
    }

    /** Takes an overlapping successor; only one with the run's key or an extension of it makes the run a chain head. */
    private attachChainSuccessor(earlier: KeyedRun, successor: KeyedRun): void {
        if (!this.keyedChainsFirst || !isExtendingExclusionKey(earlier.exclusionKey, successor.exclusionKey)) {
            return;
        }
        earlier.isChainHead = true;
        earlier.prefer?.();
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
                    const goesFirst = successor.exclusionKey === keyed.exclusionKey || successor.isChainHead;
                    successor.waitForSlot(this.keyedChainsFirst && goesFirst ? 'preferred' : 'in-turn');
                }
            }
        }
    }
}

function isOverlappingExclusionKey(left: string, right: string): boolean {
    return isExtendingExclusionKey(left, right) || isExtendingExclusionKey(right, left);
}

/** The later key equals the earlier one or extends its path. */
function isExtendingExclusionKey(earlier: string, later: string): boolean {
    return later === earlier || later.startsWith(`${earlier}:`);
}
