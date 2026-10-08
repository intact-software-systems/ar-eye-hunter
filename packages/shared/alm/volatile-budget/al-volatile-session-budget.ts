import { Either } from '../../resilience/Either.ts';
import { ALVolatileSessionReleaseQueue } from './al-volatile-session-release-queue.ts';

export const AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000;
export const AL_VOLATILE_SESSION_MAX_BYTES = 4 * 1024 * 1024;
/** The furthest deadline an outbound admission may name: past it a send is refused, not held (D179). */
export const AL_VOLATILE_SESSION_MAX_AGE_MS = 5 * 60_000;
/** The ordering tracks of this session's own ordered sends the bound holds at once (D179). */
export const AL_VOLATILE_SESSION_MAX_TRACKS = 64;
/**
 * The longest an inbound admission counts: its deadline is the sender's clock and the sender's
 * choice, so a peer whose clock runs ahead or who names a far deadline must not hold this session's own sends
 * refused. An inbound envelope is delivered at once; only small rows outlive it.
 */
export const AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS = 30_000;

export type ALVolatileSessionLimit = 'admissions' | 'bytes' | 'age' | 'tracks';

export interface ALVolatileSessionLimits {
    readonly maxAdmissions: number;
    readonly maxBytes: number;
    readonly maxAgeMs: number;
    readonly maxTracks: number;
}

export const AL_VOLATILE_SESSION_LIMITS: ALVolatileSessionLimits = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: AL_VOLATILE_SESSION_MAX_BYTES,
    maxAgeMs: AL_VOLATILE_SESSION_MAX_AGE_MS,
    maxTracks: AL_VOLATILE_SESSION_MAX_TRACKS
};

export interface ALVolatileSessionUsage {
    readonly admissions: number;
    readonly bytes: number;
    /** How long ago the oldest counted admission was admitted; 0 when nothing is counted. */
    readonly oldestAgeMs: number;
    readonly tracks: number;
}

/** `overloaded` is the count or byte bound reached; the age and track bounds refuse a send without shedding others. */
export interface ALVolatileSessionReport {
    readonly usage: ALVolatileSessionUsage;
    readonly limits: ALVolatileSessionLimits;
    readonly overloaded: boolean;
}

export namespace ALVolatileSessionBudget {
    export interface Admission {
        readonly msgId: string;
        readonly bytes: number;
        readonly deadlineAtMs: number;
        readonly nowMs: number;
        /** The ordering track an ordered send holds; `undefined` for an unordered message, which holds none. */
        readonly trackKey: string | undefined;
    }

    export interface Refusal {
        readonly limit: ALVolatileSessionLimit;
        readonly usage: ALVolatileSessionUsage;
        readonly limits: ALVolatileSessionLimits;
    }
}

interface ALVolatileSessionEntry {
    readonly bytes: number;
    readonly admittedAtMs: number;
    readonly trackKey: string | undefined;
}

/**
 * Entries stay in admission order, so the first one held is the oldest; the release queue frees each at its own
 * deadline, and a track leaves the count with its last counted admission.
 */
export class ALVolatileSessionBudget {
    private readonly limits: ALVolatileSessionLimits;
    private readonly entriesByMsgId = new Map<string, ALVolatileSessionEntry>();
    private readonly admissionsByTrackKey = new Map<string, number>();
    private readonly releases = new ALVolatileSessionReleaseQueue();
    private bytes = 0;

    constructor(limits: ALVolatileSessionLimits) {
        this.limits = limits;
    }

    tryAdmit(
        input: ALVolatileSessionBudget.Admission
    ): Either<ALVolatileSessionBudget.Refusal, ALVolatileSessionUsage> {
        this.releaseDue(input.nowMs);
        const usage = this.toUsage(input.nowMs);
        if (this.entriesByMsgId.has(input.msgId)) {
            return Either.ofRight(usage);
        }
        const limit = this.resolvePassedLimit(input, usage);
        return limit === undefined
            ? Either.ofRight(this.hold(input))
            : Either.ofLeft({ limit, usage, limits: this.limits });
    }

    /** A received message is never refused and never opens a counted track (D74, D179). */
    record(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        return this.hold({
            ...input,
            deadlineAtMs: Math.min(input.deadlineAtMs, input.nowMs + AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS),
            trackKey: undefined
        });
    }

    readReport(nowMs: number): ALVolatileSessionReport {
        this.releaseDue(nowMs);
        const usage = this.toUsage(nowMs);
        return {
            usage,
            limits: this.limits,
            overloaded: usage.admissions >= this.limits.maxAdmissions || usage.bytes >= this.limits.maxBytes
        };
    }

    private resolvePassedLimit(
        input: ALVolatileSessionBudget.Admission,
        usage: ALVolatileSessionUsage
    ): ALVolatileSessionLimit | undefined {
        if (input.deadlineAtMs - input.nowMs > this.limits.maxAgeMs) {
            return 'age';
        }
        if (usage.admissions + 1 > this.limits.maxAdmissions) {
            return 'admissions';
        }
        if (usage.bytes + input.bytes > this.limits.maxBytes) {
            return 'bytes';
        }
        const opensTrack = input.trackKey !== undefined && !this.admissionsByTrackKey.has(input.trackKey);
        return opensTrack && usage.tracks >= this.limits.maxTracks ? 'tracks' : undefined;
    }

    private hold(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        this.releaseDue(input.nowMs);
        if (!this.entriesByMsgId.has(input.msgId) && input.deadlineAtMs > input.nowMs) {
            this.entriesByMsgId.set(input.msgId, {
                bytes: input.bytes,
                admittedAtMs: input.nowMs,
                trackKey: input.trackKey
            });
            this.releases.push({ msgId: input.msgId, deadlineAtMs: input.deadlineAtMs });
            this.bytes += input.bytes;
            this.holdTrack(input.trackKey);
        }
        return this.toUsage(input.nowMs);
    }

    private releaseDue(nowMs: number): void {
        for (let due = this.releases.popDue(nowMs); due !== undefined; due = this.releases.popDue(nowMs)) {
            const entry = this.entriesByMsgId.get(due.msgId);
            if (entry !== undefined) {
                this.entriesByMsgId.delete(due.msgId);
                this.bytes -= entry.bytes;
                this.releaseTrack(entry.trackKey);
            }
        }
    }

    private holdTrack(trackKey: string | undefined): void {
        if (trackKey !== undefined) {
            this.admissionsByTrackKey.set(trackKey, (this.admissionsByTrackKey.get(trackKey) ?? 0) + 1);
        }
    }

    private releaseTrack(trackKey: string | undefined): void {
        const admissions = trackKey === undefined ? undefined : this.admissionsByTrackKey.get(trackKey);
        if (trackKey === undefined || admissions === undefined) {
            return;
        }
        if (admissions > 1) {
            this.admissionsByTrackKey.set(trackKey, admissions - 1);
        }
        else {
            this.admissionsByTrackKey.delete(trackKey);
        }
    }

    private toUsage(nowMs: number): ALVolatileSessionUsage {
        const oldest = this.entriesByMsgId.values().next().value;
        return {
            admissions: this.entriesByMsgId.size,
            bytes: this.bytes,
            oldestAgeMs: oldest === undefined ? 0 : Math.max(0, nowMs - oldest.admittedAtMs),
            tracks: this.admissionsByTrackKey.size
        };
    }
}
