import { Either } from '../../resilience/Either.ts';

export const AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000;
export const AL_VOLATILE_SESSION_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The longest an inbound admission counts (R-S3c-ii-6): its deadline is the sender's clock and the sender's
 * choice, so a peer whose clock runs ahead or who names a far deadline must not hold this session's own sends
 * refused. An inbound envelope is delivered at once; only small rows outlive it.
 */
export const AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS = 30_000;

export interface ALVolatileSessionLimits {
    readonly maxAdmissions: number;
    readonly maxBytes: number;
}

export interface ALVolatileSessionUsage {
    readonly admissions: number;
    readonly bytes: number;
}

interface ALVolatileSessionEntry {
    readonly bytes: number;
    readonly deadlineAtMs: number;
}

export namespace ALVolatileSessionBudget {
    export interface Admission {
        readonly msgId: string;
        readonly bytes: number;
        readonly deadlineAtMs: number;
        readonly nowMs: number;
    }

    export interface Refusal {
        readonly limit: 'admissions' | 'bytes';
        readonly usage: ALVolatileSessionUsage;
        readonly limits: ALVolatileSessionLimits;
    }
}

/**
 * One session's count of the data admissions its memory pairs hold (D74): the WS client's and the RTC overlay's
 * outbound pairs and the session's inbound pair share it. Each admission is released at its own deadline, computed
 * on read, so the budget schedules nothing; a msgId counts once however many carriers admit it.
 */
export class ALVolatileSessionBudget {
    private readonly limits: ALVolatileSessionLimits;
    private readonly entries = new Map<string, ALVolatileSessionEntry>();
    private bytes = 0;
    private nextReleaseAtMs = Number.POSITIVE_INFINITY;

    constructor(limits: ALVolatileSessionLimits) {
        this.limits = limits;
    }

    tryAdmit(
        input: ALVolatileSessionBudget.Admission
    ): Either<ALVolatileSessionBudget.Refusal, ALVolatileSessionUsage> {
        const usage = this.readUsage(input.nowMs);
        if (this.entries.has(input.msgId)) {
            return Either.ofRight(usage);
        }
        const limit = resolveALVolatileSessionPassedLimit(usage, input.bytes, this.limits);
        return limit === undefined
            ? Either.ofRight(this.hold(input))
            : Either.ofLeft({ limit, usage, limits: this.limits });
    }

    /** An inbound admission: never refused (C6), and counted for at most the inbound lifetime. */
    record(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        return this.hold({
            ...input,
            deadlineAtMs: Math.min(input.deadlineAtMs, input.nowMs + AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS)
        });
    }

    readUsage(nowMs: number): ALVolatileSessionUsage {
        this.releaseDue(nowMs);
        return this.toUsage();
    }

    isOverloaded(nowMs: number): boolean {
        const usage = this.readUsage(nowMs);
        return usage.admissions >= this.limits.maxAdmissions || usage.bytes >= this.limits.maxBytes;
    }

    private hold(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        this.releaseDue(input.nowMs);
        if (!this.entries.has(input.msgId) && input.deadlineAtMs > input.nowMs) {
            this.entries.set(input.msgId, { bytes: input.bytes, deadlineAtMs: input.deadlineAtMs });
            this.bytes += input.bytes;
            this.nextReleaseAtMs = Math.min(this.nextReleaseAtMs, input.deadlineAtMs);
        }
        return this.toUsage();
    }

    private releaseDue(nowMs: number): void {
        if (nowMs < this.nextReleaseAtMs) {
            return;
        }
        let nextReleaseAtMs = Number.POSITIVE_INFINITY;
        for (const [msgId, entry] of this.entries) {
            if (entry.deadlineAtMs <= nowMs) {
                this.entries.delete(msgId);
                this.bytes -= entry.bytes;
            }
            else {
                nextReleaseAtMs = Math.min(nextReleaseAtMs, entry.deadlineAtMs);
            }
        }
        this.nextReleaseAtMs = nextReleaseAtMs;
    }

    private toUsage(): ALVolatileSessionUsage {
        return { admissions: this.entries.size, bytes: this.bytes };
    }
}

function resolveALVolatileSessionPassedLimit(
    usage: ALVolatileSessionUsage,
    bytes: number,
    limits: ALVolatileSessionLimits
): ALVolatileSessionBudget.Refusal['limit'] | undefined {
    if (usage.admissions + 1 > limits.maxAdmissions) {
        return 'admissions';
    }
    return usage.bytes + bytes > limits.maxBytes ? 'bytes' : undefined;
}
