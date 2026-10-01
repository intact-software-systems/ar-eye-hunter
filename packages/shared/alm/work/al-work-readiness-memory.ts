/**
 * Why a probe had no remembered answer to give: one of the four invalidations, the memory reaching
 * its bound, or no memory ever taken. Every storage read this owner spends on readiness has one.
 */
export type ALWorkReadinessProbeCause =
    | 'no-memory'
    | 'external-wake'
    | 'own-commit'
    | 'batch'
    | 'retained-release'
    | 'age-bound';

/** What a commit wrote, as the batch it runs must account for before the answer it set aside comes back. */
export interface ALWorkCommittedRows {
    /** When the last row the commit wrote becomes claimable, or undefined when the owner cannot say. */
    readonly dueByMs: number | undefined;
    /**
     * Every work row the commit stated; an existing row is counted once more at worst, which costs one
     * probe. The batch it runs must claim at least as many.
     */
    readonly writtenCount: number;
}

/** A commit that cannot describe the rows it wrote: its batch never restores the answer it set aside. */
export const AL_WORK_UNDESCRIBED_COMMIT: ALWorkCommittedRows = { dueByMs: undefined, writtenCount: 0 };

/** One probe's answer; `readyAtMs` undefined is the probe reporting no work at all. */
export interface ALWorkReadinessAnswer {
    readonly readyAtMs: number | undefined;
    readonly observedAtMs: number;
}

/** The changes that empty a remembered answer; the other two causes describe a probe, not a change. */
export type ALWorkReadinessInvalidation = Exclude<ALWorkReadinessProbeCause, 'no-memory' | 'age-bound'>;

/** What storage answered, and why the owner had to ask it. */
export interface ALWorkReadinessProbe {
    readonly cause: ALWorkReadinessProbeCause;
    readonly readyAtMs: number | undefined;
}

/** What a batch that ran to its end did, as the restore of a suspended answer needs it. */
export interface ALWorkReadinessBatch {
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rejectedCount: number;
    readonly pageSize: number;
    readonly startedAtMs: number;
    /** A commit landed while the batch ran, so its page may not hold that commit's rows. */
    readonly commitPending: boolean;
}

/** An answer a commit set aside, and what that commit wrote. */
interface ALWorkSuspendedReadiness {
    readonly answer: ALWorkReadinessAnswer;
    readonly dueByMs: number;
    readonly writtenCount: number;
}

/**
 * How long a probe's answer stands, and what empties it. **Any change to the owner's rows performed
 * outside its batch must reach `forget` or `suspend`, and a claim that may write the owner's rows
 * inside its batch must reach `forget` before it runs**, or the owner keeps answering from a picture
 * storage no longer supports.
 */
export class ALWorkReadinessMemory {
    private readonly memoryMs: number;
    private answer: ALWorkReadinessAnswer | undefined;
    private suspended: ALWorkSuspendedReadiness | undefined;
    /** Bumped by every invalidation, so a probe that started before one cannot store its stale answer. */
    private generation = 0;
    /** The first invalidation since the last probe started: what the next probe without an answer reports. */
    private invalidation: ALWorkReadinessInvalidation | undefined;
    private probeInFlight = false;

    constructor(memoryMs: number) {
        this.memoryMs = memoryMs;
    }

    /** The remembered answer while it stands, or undefined when storage must answer. */
    getStandingAnswer(nowMs: number): ALWorkReadinessAnswer | undefined {
        const { answer } = this;
        return answer !== undefined && isALWorkReadinessAnswerStanding(answer, nowMs, this.memoryMs)
            ? answer
            : undefined;
    }

    /** Reads storage through `read` and remembers its answer, unless an invalidation landed meanwhile. */
    async readProbe(
        nowMs: number,
        read: () => Promise<number | undefined>
    ): Promise<ALWorkReadinessProbe> {
        const cause = this.answer === undefined ? this.invalidation ?? 'no-memory' : 'age-bound';
        this.invalidation = undefined;
        const generation = this.generation;
        this.probeInFlight = true;
        try {
            const readyAtMs = await read();
            if (generation === this.generation) {
                this.answer = { readyAtMs, observedAtMs: nowMs };
            }
            return { cause, readyAtMs };
        }
        finally {
            this.probeInFlight = false;
        }
    }

    forget(cause: ALWorkReadinessInvalidation): void {
        const discards = this.answer !== undefined || this.suspended !== undefined ||
            this.probeInFlight;
        if (discards && this.invalidation === undefined) {
            // The first change since the last probe owns the next one: a commit runs a batch, and
            // that batch's own invalidation must not take the credit from the commit.
            this.invalidation = cause;
        }
        this.answer = undefined;
        this.suspended = undefined;
        this.generation += 1;
    }

    /** A commit invalidates the answer, but keeps it aside for the batch it runs to restore. */
    suspend(written: ALWorkCommittedRows): void {
        const standing = this.answer;
        const { dueByMs, writtenCount } = written;
        this.forget('own-commit');
        this.suspended = standing === undefined || dueByMs === undefined
            ? undefined
            : { answer: standing, dueByMs, writtenCount };
    }

    /**
     * A batch's end: the answer its commit set aside comes back, with its own age, when the batch
     * left storage as that answer saw it, and every other answer is dropped. Returns the restored one.
     */
    settle(batch: ALWorkReadinessBatch | undefined): ALWorkReadinessAnswer | undefined {
        const restored = batch === undefined
            ? undefined
            : resolveALWorkRestoredReadiness(this.suspended, batch, this.memoryMs);
        this.forget('batch');
        if (restored !== undefined) {
            this.answer = restored;
            this.invalidation = undefined;
        }
        return restored;
    }
}

/** An answer stands from its probe until the memory bound; a clock that stepped back behind the probe ends it. */
function isALWorkReadinessAnswerStanding(
    answer: ALWorkReadinessAnswer,
    nowMs: number,
    memoryMs: number
): boolean {
    return nowMs >= answer.observedAtMs && nowMs - answer.observedAtMs < memoryMs;
}

/**
 * The suspended answer still describes storage only when the commit's batch claimed every row the
 * commit wrote and finished each one. The commit described its rows: an undescribed commit never
 * restores. The batch started once those rows were all due, and claimed at least as many rows as
 * the commit wrote, so a row the queue did not return, for any reason, refuses the restore. It
 * claimed fewer than a page, completed every claim, rejected and retained nothing, and no commit
 * landed behind it. The answer still stood when the batch started and was not due by then: a due
 * answer would start a batch that claims nothing on every engine round.
 *
 * This rests on every claim that may write work rows outside a commit announcing it: such a claim
 * empties the set-aside answer, so a clean batch's completed claims wrote nothing unannounced.
 */
function resolveALWorkRestoredReadiness(
    suspended: ALWorkSuspendedReadiness | undefined,
    batch: ALWorkReadinessBatch,
    memoryMs: number
): ALWorkReadinessAnswer | undefined {
    if (
        suspended === undefined || batch.commitPending ||
        suspended.dueByMs > batch.startedAtMs
    ) {
        return undefined;
    }
    const { answer } = suspended;
    const clean = batch.claimedCount >= suspended.writtenCount && batch.claimedCount < batch.pageSize &&
        batch.rejectedCount === 0 && batch.completedCount === batch.claimedCount;
    const notDue = answer.readyAtMs === undefined || answer.readyAtMs > batch.startedAtMs;
    return clean && notDue && isALWorkReadinessAnswerStanding(answer, batch.startedAtMs, memoryMs)
        ? answer
        : undefined;
}
