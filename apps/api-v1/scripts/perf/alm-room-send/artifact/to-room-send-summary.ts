import type { RoomSendProcessFigures } from '../compute-room-send-process-figures.ts';
import type { RoomSendAnswerFigures } from '../report/compute-room-send-answer-figures.ts';
import type { RoomSendDelaySummary } from '../report/compute-room-send-delay-summary.ts';
import type { RoomSendReport } from '../report/compute-room-send-report.ts';
import type { RoomSendResendCauseFigures } from '../report/compute-room-send-resend-figures.ts';
import type { RoomSendArtifact } from './to-room-send-artifact.ts';

/** What of an artifact its summary prints. */
export type RoomSendSummarySource = Pick<
    RoomSendArtifact,
    'commit' | 'dirty' | 'shape' | 'applicationPool' | 'observation' | 'loadAverage' | 'run' | 'report'
>;

const MS_PER_SECOND = 1_000;
const SHORT_COMMIT_LENGTH = 7;

/** A percentile over expected copies is out of reach when its rank lands on a copy the server never wrote. */
const NOT_REACHED = 'not reached';
const NO_SAMPLE = 'no sample';
/** In place of a figure that needs a track, for a run of unordered sends: such a figure is never printed as 0. */
const NO_TRACK = 'not applicable: unordered sends have no track';

/**
 * The lines a run prints once it has ended, in the order to print them. The first line names the ordering of the
 * run's sends as its shape states it. The delay of that line is nominal: it is what the shape asks for, added to the
 * round trips the artifact lists as delayed and no others, and each wait is a timer that fires late. A copy is
 * "written to the recipient's socket": a frame on the wire, which is no delivery to an application. How many of the
 * written copies named an ordering key is counted from those frames, so the copies line shows what the first line
 * states. A control a send drew is counted as drawn, never as a send lost. An offer that threw is printed with the
 * name of its error and the first message under that name, which `toRoomSendThrownError` bounded and cleared of URLs
 * when it was recorded. The copies written out of the order offered are worded by the ordering of the run's sends,
 * and the two figures that need a track, the copies past a predecessor never written and the view before each
 * track's first control, are printed as not applicable for a run of unordered sends. The last three lines are there
 * only when a count of theirs is above zero.
 */
export function toRoomSendSummary(source: RoomSendSummarySource): readonly string[] {
    return [
        ...toRunLines(source),
        ...toSendLines(source.report),
        ...toCopyLines(source.report),
        ...toReceiptLines(source.report),
        ...toRecoveryLines(source),
        toProcessLine('send window', source.run.sendWindow),
        toProcessLine('tail', source.run.tail),
        ...toStrayLines(source.report)
    ];
}

function toRunLines(source: RoomSendSummarySource): readonly string[] {
    const { shape, applicationPool, observation, loadAverage } = source;
    const commit = source.commit.slice(0, SHORT_COMMIT_LENGTH) + (source.dirty ? ' with uncommitted changes' : '');
    return [
        `ALM room-send cell: ordering ${shape.ordering}; ${shape.publishers} publishers x ` +
        `${shape.sendsPerSecond} sends/s for ${shape.durationS} s; ` +
        `+${shape.delayMs} ms nominal on the delayed database round trips; ` +
        `sender recovery ${shape.senderRecovery}; application pool ${applicationPool.effectiveMaxConnections} ` +
        `(API default ${applicationPool.apiV1DefaultMaxConnections})`,
        `commit ${commit}; observed ${toSeconds(observation.tailMs)} past the last offer; ` +
        `run wall time ${toSeconds(source.run.wallMs)}; ` +
        `load average ${loadAverage.atStart[0].toFixed(2)} at start, ${loadAverage.atEnd[0].toFixed(2)} at end`
    ];
}

function toSendLines(report: RoomSendReport): readonly string[] {
    const { sends } = report;
    return [
        `sends offered: ${sends.attempted}; the entry answered ${toCountsAboveZero(sends.byAcceptance)}`,
        toThrownOffersLine(report),
        `lateness of an offer against its due time: p50 ${toDelay(sends.latenessMs.p50, NO_SAMPLE)}, ` +
        `p95 ${toDelay(sends.latenessMs.p95, NO_SAMPLE)}, max ${toDelay(sends.latenessMs.max, NO_SAMPLE)}`
    ];
}

function toCopyLines(report: RoomSendReport): readonly string[] {
    const { delivery, recipientDelays, sends } = report;
    const overExpected = recipientDelays.dueToFirstReadOverExpectedCopiesMs;
    const overWritten = recipientDelays.dueToFirstReadMs;
    return [
        `copies written to the recipient's socket: ${delivery.copiesRead} of ${delivery.copiesExpected} expected, ` +
        `${delivery.copiesNamingAnOrderingKey} naming an ordering key; ` +
        `sends written to every recipient ${delivery.deliveredToEveryRecipient}, ` +
        `to at least one ${delivery.deliveredToAnyRecipient}`,
        `due time to first write, over the ${overExpected.count} expected copies: ` +
        `p50 ${toDelay(overExpected.p50, NOT_REACHED)}, p95 ${toDelay(overExpected.p95, NOT_REACHED)}, ` +
        `p99 ${toDelay(overExpected.p99, NOT_REACHED)}`,
        `due time to first write, over the ${overWritten.count} written copies: ` +
        `p50 ${toDelay(overWritten.p50, NO_SAMPLE)}, p95 ${toDelay(overWritten.p95, NO_SAMPLE)}, ` +
        `max ${toDelay(overWritten.max, NO_SAMPLE)}`,
        toCopyOrderLine(report),
        `sends a server instance handed to its application subscriber: ${delivery.handedToApplication} of ` +
        `${sends.attempted}; more than once ${delivery.handedMoreThanOnce} ` +
        `(the most hand-offs of one send: ${delivery.largestHandOffMultiplicity ?? 0}); ` +
        `answered pending-admission and never handed ${delivery.pendingAdmissionNeverHanded}`
    ];
}

/** The repeats and the order on the wire. Only a send on a track has a predecessor its copy can be written past. */
function toCopyOrderLine(report: RoomSendReport): string {
    const { delivery, tracks } = report;
    const repeats = `copies written more than once ${delivery.copiesReadMoreThanOnce}`;
    switch (tracks.kind) {
        case 'ordering-key':
            return `${repeats}, ahead of a lower seq of their track ${delivery.copiesReadOutOfOfferOrder}, ` +
                `past a predecessor never written ${tracks.copiesReadPastAnUnreadPredecessor}`;
        case 'not-applicable':
            return `${repeats}, ahead of an earlier send of their publisher ${delivery.copiesReadOutOfOfferOrder}; ` +
                `past a predecessor never written: ${NO_TRACK}`;
    }
}

/** The offers of each kind that threw, by the name of the error, with the first message under each name. */
function toThrownOffersLine(report: RoomSendReport): string {
    const offersOfEachKind: readonly (readonly [string, RoomSendAnswerFigures])[] = [
        ['sends', report.sends],
        ['resends', report.resends],
        ['ACKs', report.acks]
    ];
    const thrown = offersOfEachKind.flatMap(([kind, figures]) => {
        const byErrorName = Object.entries(figures.threwByErrorName)
            .map(([errorName, count]) =>
                `${errorName} ${count} ("${figures.firstThrownMessageByErrorName[errorName]}")`
            );
        return byErrorName.length === 0 ? [] : [`${kind} ${byErrorName.join(', ')}`];
    });
    return `offers that threw: ${thrown.length === 0 ? 'none' : thrown.join('; ')}`;
}

function toReceiptLines(report: RoomSendReport): readonly string[] {
    const { receipts, acks } = report;
    return [
        `receipts, of the ${receipts.expected} sends that expect one: complete ${receipts.complete}, ` +
        `timed out ${receipts.timedOut}, admitted only ${receipts.admittedWithoutTerminal}, ` +
        `none ${receipts.noReceipt}`,
        `offer to admitted receipt: ${toP50AndP95(receipts.offerToAdmittedMs)}; ` +
        `offer to complete receipt: ${toP50AndP95(receipts.offerToCompleteMs)}`,
        `ACKs the recipients offered: ${acks.offered}; the entry answered ${toCountsAboveZero(acks.byAcceptance)}` +
        (acks.byAcceptance.rejected === 0 ? '' : ` (${toCountsAboveZero(acks.rejectedByCode)})`)
    ];
}

/** What the server asked of the publishers, what they offered again, and the server's work before it first asked. */
function toRecoveryLines(source: RoomSendSummarySource): readonly string[] {
    const { controls, resends, standIn } = source.report;
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
        toBeforeFirstControlLine(source)
    ];
}

function toBeforeFirstControlLine(source: RoomSendSummarySource): string {
    const { tracks } = source.report;
    if (tracks.kind === 'not-applicable') {
        return `before each track's first control: ${NO_TRACK}`;
    }
    const { beforeFirstControl } = tracks;
    const delays = beforeFirstControl.dueToFirstReadOverExpectedCopiesMs;
    return `before each track's first control (${beforeFirstControl.tracksWithAControl} of ` +
        `${source.shape.publishers} tracks drew one): ${beforeFirstControl.sends} sends, ` +
        `${beforeFirstControl.copiesRead} of ${beforeFirstControl.copiesExpected} copies written; ` +
        `due time to first write over expected copies p50 ${toDelay(delays.p50, NOT_REACHED)}, ` +
        `p95 ${toDelay(delays.p95, NOT_REACHED)}`;
}

/** How loaded the run's process was over one span. The loop's lag says whether its one event loop kept up. */
function toProcessLine(span: string, figures: RoomSendProcessFigures): string {
    const { loopLag, cpu } = figures;
    const lateTicks = loopLag.shareOfTicksOverOneMsLate === null
        ? NO_SAMPLE
        : `${(loopLag.shareOfTicksOverOneMsLate * 100).toFixed(1)}%`;
    return `${span}: ${toSeconds(figures.wallMs)}; event-loop lag p50 ${toDelay(loopLag.p50Ms, NO_SAMPLE)}, ` +
        `p95 ${toDelay(loopLag.p95Ms, NO_SAMPLE)}, p99 ${toDelay(loopLag.p99Ms, NO_SAMPLE)}, ` +
        `max ${toDelay(loopLag.maxMs, NO_SAMPLE)}, ${lateTicks} of ticks over 1 ms late; ` +
        `processor time of the ${cpu.scope}: ${
            cpu.coresBusy === null ? NO_SAMPLE : cpu.coresBusy.toFixed(2)
        } cores busy`;
}

/** What a run of the cell leaves at zero: each line is printed only when a count of it is above zero. */
function toStrayLines(report: RoomSendReport): readonly string[] {
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

function toResendsOfCause(resends: RoomSendResendCauseFigures): string {
    return resends.count === 0 ? '0' : `${resends.count} (answered ${toCountsAboveZero(resends.byAcceptance)})`;
}

/** A count with the keys that make it up, or `none` for 0. */
function toCountWithBreakdown(count: number, counts: Readonly<Record<string, number>>): string {
    return count === 0 ? 'none' : `${count} (${toCountsAboveZero(counts)})`;
}

function toP50AndP95(delays: RoomSendDelaySummary): string {
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
