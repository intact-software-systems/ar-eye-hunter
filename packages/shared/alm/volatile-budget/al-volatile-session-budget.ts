import { Either } from '../../resilience/Either.ts';

/** The data admissions one session's memory pairs hold at once (D74). */
export const AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000;
/** The envelope bytes one session's memory pairs hold at once (D74). */
export const AL_VOLATILE_SESSION_MAX_BYTES = 4 * 1024 * 1024;

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
    /** One data message, counted from its admission until its own deadline. */
    export interface Admission {
        readonly msgId: string;
        readonly bytes: number;
        readonly deadlineAtMs: number;
        readonly nowMs: number;
    }

    /** The limit a new admission would pass, and the usage it met. */
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

    /** An outbound admission: refused when it would pass either limit (D78). */
    tryAdmit(
        input: ALVolatileSessionBudget.Admission
    ): Either<ALVolatileSessionBudget.Refusal, ALVolatileSessionUsage> {
        const usage = this.readUsage(input.nowMs);
        if (this.entries.has(input.msgId)) {
            return Either.ofRight(usage);
        }
        const limit = resolveALVolatileSessionPassedLimit(usage, input.bytes, this.limits);
        return limit === undefined
            ? Either.ofRight(this.record(input))
            : Either.ofLeft({ limit, usage, limits: this.limits });
    }

    /** An inbound admission: counted, never refused (C6). */
    record(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        this.releaseDue(input.nowMs);
        if (!this.entries.has(input.msgId) && input.deadlineAtMs > input.nowMs) {
            this.entries.set(input.msgId, { bytes: input.bytes, deadlineAtMs: input.deadlineAtMs });
            this.bytes += input.bytes;
            this.nextReleaseAtMs = Math.min(this.nextReleaseAtMs, input.deadlineAtMs);
        }
        return this.toUsage();
    }

    readUsage(nowMs: number): ALVolatileSessionUsage {
        this.releaseDue(nowMs);
        return this.toUsage();
    }

    /** At or over either limit: what the session's QoS provider states as `overloaded` (C13). */
    isOverloaded(nowMs: number): boolean {
        const usage = this.readUsage(nowMs);
        return usage.admissions >= this.limits.maxAdmissions || usage.bytes >= this.limits.maxBytes;
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
