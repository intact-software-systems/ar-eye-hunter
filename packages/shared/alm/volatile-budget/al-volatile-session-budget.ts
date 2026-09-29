import { Either } from '../../resilience/Either.ts';
import { ALVolatileSessionReleaseQueue } from './al-volatile-session-release-queue.ts';

export const AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000;
export const AL_VOLATILE_SESSION_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The longest an inbound admission counts: its deadline is the sender's clock and the sender's
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

export class ALVolatileSessionBudget {
    private readonly limits: ALVolatileSessionLimits;
    private readonly bytesByMsgId = new Map<string, number>();
    private readonly releases = new ALVolatileSessionReleaseQueue();
    private bytes = 0;

    constructor(limits: ALVolatileSessionLimits) {
        this.limits = limits;
    }

    tryAdmit(
        input: ALVolatileSessionBudget.Admission
    ): Either<ALVolatileSessionBudget.Refusal, ALVolatileSessionUsage> {
        const usage = this.readUsage(input.nowMs);
        if (this.bytesByMsgId.has(input.msgId)) {
            return Either.ofRight(usage);
        }
        const limit = resolveALVolatileSessionPassedLimit(usage, input.bytes, this.limits);
        return limit === undefined
            ? Either.ofRight(this.hold(input))
            : Either.ofLeft({ limit, usage, limits: this.limits });
    }

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
        if (!this.bytesByMsgId.has(input.msgId) && input.deadlineAtMs > input.nowMs) {
            this.bytesByMsgId.set(input.msgId, input.bytes);
            this.releases.push({ msgId: input.msgId, deadlineAtMs: input.deadlineAtMs });
            this.bytes += input.bytes;
        }
        return this.toUsage();
    }

    private releaseDue(nowMs: number): void {
        for (let due = this.releases.popDue(nowMs); due !== undefined; due = this.releases.popDue(nowMs)) {
            this.bytes -= this.bytesByMsgId.get(due.msgId) ?? 0;
            this.bytesByMsgId.delete(due.msgId);
        }
    }

    private toUsage(): ALVolatileSessionUsage {
        return { admissions: this.bytesByMsgId.size, bytes: this.bytes };
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
