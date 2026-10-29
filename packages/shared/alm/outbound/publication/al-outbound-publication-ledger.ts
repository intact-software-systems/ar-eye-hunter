import type {
    ALPublicationStageLimit,
    ALPublicationStageLimits
} from '../../../al-contracts/publication/al-publication-stage-limits.ts';

/** Cumulative over the stage's lifetime: each outcome it settled, and what its opportunities admitted and deferred. */
export interface ALOutboundPublicationCounters {
    readonly staged: number;
    readonly superseded: number;
    readonly expired: number;
    readonly refused: number;
    readonly cancelled: number;
    /** Values handed to `submit`. */
    readonly admitted: number;
    /** Values an opportunity left for a later one, counted at each opportunity that left them. */
    readonly deferred: number;
}

/** What the stage holds now across its lanes, against its limits. */
export interface ALOutboundPublicationLedgerReport {
    readonly streams: number;
    readonly staged: number;
    readonly stagedBytes: number;
    readonly limits: ALPublicationStageLimits;
    readonly counters: ALOutboundPublicationCounters;
}

interface ALOutboundPublicationTotals {
    readonly streams: number;
    readonly staged: number;
    readonly stagedBytes: number;
}

export namespace ALOutboundPublicationLedger {
    export interface Value {
        readonly bytes: number;
    }

    /** One stream's values before and after a change, oldest first; an empty list is a stream the stage does not hold. */
    export interface StreamChange {
        readonly previous: readonly Value[];
        readonly next: readonly Value[];
    }

    export interface Refusal {
        readonly limit: ALPublicationStageLimit;
        readonly detail: string;
    }

    export type Outcome = keyof ALOutboundPublicationCounters;
}

/**
 * Counts what one publication stage holds across its lanes and what it settled (D477). Every change to a stream's
 * values passes through `recordStreamChange`, so the totals are the streams' contents and never drift from them.
 */
export class ALOutboundPublicationLedger {
    private readonly limits: ALPublicationStageLimits;
    private totals: ALOutboundPublicationTotals = { streams: 0, staged: 0, stagedBytes: 0 };
    private counters: ALOutboundPublicationCounters = {
        staged: 0,
        superseded: 0,
        expired: 0,
        refused: 0,
        cancelled: 0,
        admitted: 0,
        deferred: 0
    };

    constructor(limits: ALPublicationStageLimits) {
        this.limits = limits;
    }

    /** The first limit, in the order streams, staged values, staged bytes, that the change would pass. */
    resolveRefusal(change: ALOutboundPublicationLedger.StreamChange): ALOutboundPublicationLedger.Refusal | undefined {
        const after = this.computeTotalsAfter(change);
        if (after.streams > this.limits.maxStreams) {
            return {
                limit: 'streams',
                detail: `Staging the value would open stream ${after.streams}, past the stage's limit of ` +
                    `${this.limits.maxStreams}.`
            };
        }
        if (after.staged > this.limits.maxStagedValues) {
            return {
                limit: 'staged-values',
                detail: `Staging the value would hold ${after.staged} values, past the stage's limit of ` +
                    `${this.limits.maxStagedValues}.`
            };
        }
        if (after.stagedBytes > this.limits.maxStagedBytes) {
            return {
                limit: 'staged-bytes',
                detail: `Staging the value would hold ${after.stagedBytes} bytes, past the stage's limit of ` +
                    `${this.limits.maxStagedBytes}.`
            };
        }
        return undefined;
    }

    recordStreamChange(change: ALOutboundPublicationLedger.StreamChange): void {
        this.totals = this.computeTotalsAfter(change);
    }

    count(outcome: ALOutboundPublicationLedger.Outcome, values: number): void {
        this.counters = { ...this.counters, [outcome]: this.counters[outcome] + values };
    }

    readReport(): ALOutboundPublicationLedgerReport {
        return { ...this.totals, limits: this.limits, counters: this.counters };
    }

    private computeTotalsAfter(change: ALOutboundPublicationLedger.StreamChange): ALOutboundPublicationTotals {
        return {
            streams: this.totals.streams + Number(change.next.length > 0) - Number(change.previous.length > 0),
            staged: this.totals.staged + change.next.length - change.previous.length,
            stagedBytes: this.totals.stagedBytes + computeBytes(change.next) - computeBytes(change.previous)
        };
    }
}

function computeBytes(values: readonly ALOutboundPublicationLedger.Value[]): number {
    return values.reduce((bytes, value) => bytes + value.bytes, 0);
}
