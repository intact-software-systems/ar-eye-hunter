import type { OrderedSendDelaySummary } from '../report/compute-ordered-send-delay-summary.ts';
import type { OrderedSendReport } from '../report/compute-ordered-send-report.ts';
import type { OrderedSendResendCauseFigures } from '../report/compute-ordered-send-resend-figures.ts';
import type { OrderedSendArtifact } from './to-ordered-send-artifact.ts';

/** What of an artifact its summary prints. */
export type OrderedSendSummarySource = Pick<
    OrderedSendArtifact,
    'commit' | 'dirty' | 'shape' | 'applicationPool' | 'observation' | 'loadAverage' | 'run' | 'report'
>;

const MS_PER_SECOND = 1_000;
const SHORT_COMMIT_LENGTH = 7;

/** A percentile over expected copies is out of reach when its rank lands on a copy the server never wrote. */
const NOT_REACHED = 'not reached';
const NO_SAMPLE = 'no sample';

/**
 * The lines a run prints once it has ended, in the order to print them. A copy is "written to the recipient's
 * socket": a frame on the wire, which is no delivery to an application. A control a send drew is counted as drawn,
 * never as a send lost. The last three lines are there only when a count of theirs is above zero.
 */
export function toOrderedSendSummary(source: OrderedSendSummarySource): readonly string[] {
    return [
        ...toRunLines(source),
        ...toSendLines(source.report),
        ...toCopyLines(source.report),
        ...toReceiptLines(source.report),
        ...toRecoveryLines(source),
        toSendWindowLine(source.run.sendWindow),
        ...toStrayLines(source.report)
    ];
}

function toRunLines(source: OrderedSendSummarySource): readonly string[] {
    const { shape, applicationPool, observation, loadAverage } = source;
    const commit = source.commit.slice(0, SHORT_COMMIT_LENGTH) + (source.dirty ? ' with uncommitted changes' : '');
    return [
        `ALM ordered-send cell: ${shape.publishers} publishers x ${shape.sendsPerSecond} sends/s for ` +
        `${shape.durationS} s; +${shape.delayMs} ms on each database round trip; ` +
        `sender recovery ${shape.senderRecovery}; application pool ${applicationPool.effectiveMaxConnections} ` +
        `(API default ${applicationPool.apiV1DefaultMaxConnections})`,
        `commit ${commit}; observed ${toSeconds(observation.tailMs)} past the last offer; ` +
        `run wall time ${toSeconds(source.run.wallMs)}; ` +
        `load average ${loadAverage.atStart[0].toFixed(2)} at start, ${loadAverage.atEnd[0].toFixed(2)} at end`
    ];
}

function toSendLines(report: OrderedSendReport): readonly string[] {
    const { sends } = report;
    return [
        `sends offered: ${sends.attempted}; the entry answered ${toCountsAboveZero(sends.byAcceptance)}`,
        `lateness of an offer against its due time: p50 ${toDelay(sends.latenessMs.p50, NO_SAMPLE)}, ` +
        `p95 ${toDelay(sends.latenessMs.p95, NO_SAMPLE)}, max ${toDelay(sends.latenessMs.max, NO_SAMPLE)}`
    ];
}

function toCopyLines(report: OrderedSendReport): readonly string[] {
    const { delivery, recipientDelays, sends } = report;
    const overExpected = recipientDelays.dueToFirstReadOverExpectedCopiesMs;
    const overWritten = recipientDelays.dueToFirstReadMs;
    return [
        `copies written to the recipient's socket: ${delivery.copiesRead} of ${delivery.copiesExpected} expected; ` +
        `sends written to every recipient ${delivery.deliveredToEveryRecipient}, ` +
        `to at least one ${delivery.deliveredToAnyRecipient}`,
        `due time to first write, over the ${overExpected.count} expected copies: ` +
        `p50 ${toDelay(overExpected.p50, NOT_REACHED)}, p95 ${toDelay(overExpected.p95, NOT_REACHED)}, ` +
        `p99 ${toDelay(overExpected.p99, NOT_REACHED)}`,
        `due time to first write, over the ${overWritten.count} written copies: ` +
        `p50 ${toDelay(overWritten.p50, NO_SAMPLE)}, p95 ${toDelay(overWritten.p95, NO_SAMPLE)}, ` +
        `max ${toDelay(overWritten.max, NO_SAMPLE)}`,
        `copies written more than once ${delivery.copiesReadMoreThanOnce}, ` +
        `ahead of a lower seq of their track ${delivery.copiesReadOutOfTrackOrder}, ` +
        `past a predecessor never written ${delivery.copiesReadPastAnUnreadPredecessor}`,
        `sends a server instance handed to its application subscriber: ${delivery.handedToApplication} of ` +
        `${sends.attempted}; more than once ${delivery.handedMoreThanOnce} ` +
        `(the most hand-offs of one send: ${delivery.largestHandOffMultiplicity ?? 0}); ` +
        `answered pending-admission and never handed ${delivery.pendingAdmissionNeverHanded}`
    ];
}

function toReceiptLines(report: OrderedSendReport): readonly string[] {
    const { receipts } = report;
    return [
        `receipts, of the ${receipts.expected} sends that expect one: complete ${receipts.complete}, ` +
        `timed out ${receipts.timedOut}, admitted only ${receipts.admittedWithoutTerminal}, ` +
        `none ${receipts.noReceipt}`,
        `offer to admitted receipt: ${toP50AndP95(receipts.offerToAdmittedMs)}; ` +
        `offer to complete receipt: ${toP50AndP95(receipts.offerToCompleteMs)}`
    ];
}

/** What the server asked of the publishers, what they offered again, and the server's work before it first asked. */
function toRecoveryLines(source: OrderedSendSummarySource): readonly string[] {
    const { controls, resends, beforeFirstControl, standIn } = source.report;
    const beforeFirstControlDelays = beforeFirstControl.dueToFirstReadOverExpectedCopiesMs;
    return [
        controls.byType.nack + controls.byType.repair === 0
            ? 'controls the server sent its publishers: none'
            : `controls the server sent its publishers: ${controls.byType.nack} nack ` +
                `(${toCountsAboveZero(controls.nacksByReason)}), ${controls.byType.repair} repair ` +
                `(${toCountsAboveZero(controls.repairsByReason)}); sends that drew a nack ` +
                `${controls.sendsWithANack}, a repair request ${controls.sendsWithARepairRequest}`,
        resends.count === 0
            ? 'resends: none'
            : `resends: repair ${toResendsOfCause(resends.byCause.repair)}, ` +
                `first-hop ${toResendsOfCause(resends.byCause['first-hop'])}; ` +
                `sends offered again ${resends.sendsResent}`,
        ...(source.shape.senderRecovery === 'client-stand-in'
            ? [
                `sends the stand-in ended: ${toCountWithBreakdown(standIn.sendsEnded, standIn.endsByCause)}; ` +
                `repairs it declined for an ended or expired send: ` +
                toCountWithBreakdown(standIn.repairsDeclined, standIn.repairsDeclinedByReason)
            ]
            : []),
        `before each track's first control (${beforeFirstControl.tracksWithAControl} of ` +
        `${source.shape.publishers} tracks drew one): ${beforeFirstControl.sends} sends, ` +
        `${beforeFirstControl.copiesRead} of ${beforeFirstControl.copiesExpected} copies written; ` +
        `due time to first write over expected copies p50 ${toDelay(beforeFirstControlDelays.p50, NOT_REACHED)}, ` +
        `p95 ${toDelay(beforeFirstControlDelays.p95, NOT_REACHED)}`
    ];
}

function toSendWindowLine(sendWindow: OrderedSendSummarySource['run']['sendWindow']): string {
    const { loopLag, cpu } = sendWindow;
    const lateTicks = loopLag.shareOfTicksOverOneMsLate === null
        ? NO_SAMPLE
        : `${(loopLag.shareOfTicksOverOneMsLate * 100).toFixed(1)}%`;
    return `send window: ${toSeconds(sendWindow.wallMs)}; event-loop lag p50 ${toDelay(loopLag.p50Ms, NO_SAMPLE)}, ` +
        `p95 ${toDelay(loopLag.p95Ms, NO_SAMPLE)}, p99 ${toDelay(loopLag.p99Ms, NO_SAMPLE)}, ` +
        `max ${toDelay(loopLag.maxMs, NO_SAMPLE)}, ${lateTicks} of ticks over 1 ms late; ` +
        `processor ${cpu.coresBusy === null ? NO_SAMPLE : cpu.coresBusy.toFixed(2)} cores busy`;
}

/** What a run of the cell leaves at zero: each line is printed only when a count of it is above zero. */
function toStrayLines(report: OrderedSendReport): readonly string[] {
    const unrecordedSamples = {
        'sends.latenessMs': report.sends.latenessMs.unrecordedSamples,
        'sends.offerToAnswerMs': report.sends.offerToAnswerMs.unrecordedSamples,
        'delivery.offerToFirstHandOffMs': report.delivery.offerToFirstHandOffMs.unrecordedSamples,
        'recipientDelays.dueToFirstReadMs': report.recipientDelays.dueToFirstReadMs.unrecordedSamples,
        'recipientDelays.offerToFirstReadMs': report.recipientDelays.offerToFirstReadMs.unrecordedSamples,
        'receipts.offerToAdmittedMs': report.receipts.offerToAdmittedMs.unrecordedSamples,
        'receipts.offerToCompleteMs': report.receipts.offerToCompleteMs.unrecordedSamples,
        'receipts.offerToTimedOutMs': report.receipts.offerToTimedOutMs.unrecordedSamples
    };
    const copiesReadBeforeTheirOffer = report.recipientDelays.copiesReadBeforeTheirOffer;
    return [
        ...toLineOfCountsAboveZero('recorded beside the sends the cell knows', { ...report.unmatched }),
        ...toLineOfCountsAboveZero('delays below zero, in no figure', unrecordedSamples),
        ...(copiesReadBeforeTheirOffer > 0
            ? [`copies written before their send's offer was read, in no delay figure: ${copiesReadBeforeTheirOffer}`]
            : [])
    ];
}

function toResendsOfCause(resends: OrderedSendResendCauseFigures): string {
    return resends.count === 0 ? '0' : `${resends.count} (answered ${toCountsAboveZero(resends.byAcceptance)})`;
}

/** A count with the keys that make it up, or `none` for 0. */
function toCountWithBreakdown(count: number, counts: Readonly<Record<string, number>>): string {
    return count === 0 ? 'none' : `${count} (${toCountsAboveZero(counts)})`;
}

function toP50AndP95(delays: OrderedSendDelaySummary): string {
    return `p50 ${toDelay(delays.p50, NO_SAMPLE)}, p95 ${toDelay(delays.p95, NO_SAMPLE)}`;
}

function toLineOfCountsAboveZero(title: string, counts: Readonly<Record<string, number>>): readonly string[] {
    return Object.values(counts).some((count) => count > 0) ? [`${title}: ${toCountsAboveZero(counts)}`] : [];
}

/** The keys with a count above zero, in the order the record holds them; `none` when there is none. */
function toCountsAboveZero(counts: Readonly<Record<string, number>>): string {
    const countsAboveZero = Object.entries(counts).filter(([, count]) => count > 0);
    return countsAboveZero.length === 0 ? 'none' : countsAboveZero.map(([key, count]) => `${key} ${count}`).join(', ');
}

/** A delay under a second in milliseconds to one decimal, a longer one in seconds to two; `absent` for none. */
function toDelay(delayMs: number | null, absent: string): string {
    if (delayMs === null) {
        return absent;
    }
    return delayMs < MS_PER_SECOND ? `${delayMs.toFixed(1)} ms` : `${(delayMs / MS_PER_SECOND).toFixed(2)} s`;
}

function toSeconds(durationMs: number): string {
    return `${(durationMs / MS_PER_SECOND).toFixed(1)} s`;
}
