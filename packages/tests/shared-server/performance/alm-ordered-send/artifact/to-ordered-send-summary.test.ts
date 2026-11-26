import { describe, expect, it } from 'vitest';

import {
    toOrderedSendSummary,
    type OrderedSendSummarySource
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/artifact/to-ordered-send-summary.ts';
import type { OrderedSendDelaySummary } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/report/compute-ordered-send-delay-summary.ts';
import {
    computeOrderedSendReport,
    type OrderedSendReport
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/report/compute-ordered-send-report.ts';

/** The report of a run that observed nothing: every count 0, every delay without a sample. */
const NO_FIGURES: OrderedSendReport = computeOrderedSendReport({
    sends: [],
    resends: [],
    acks: [],
    arrivals: [],
    handOffs: [],
    receipts: [],
    controls: [],
    unclassifiedControls: [],
    sendEnds: [],
    declinedRepairs: [],
    observationEndedAtMs: 0
});

const NO_DELAYS: OrderedSendDelaySummary = NO_FIGURES.sends.latenessMs;

/**
 * A run whose tracks stalled: 200 sends to 14 recipients each, of whose 2800 copies the server wrote 434, with every
 * figure the summary prints set here by hand.
 */
const STALLED_RUN: OrderedSendSummarySource = {
    commit: 'abc1234def5678900000000000000000000000ff',
    dirty: false,
    shape: {
        publishers: 5,
        sendsPerSecond: 2,
        durationS: 20,
        delayMs: 5,
        senderRecovery: 'client-stand-in',
        applicationPoolMaxConnections: 5
    },
    applicationPool: { effectiveMaxConnections: 5, apiV1DefaultMaxConnections: 5 },
    observation: { tailMs: 75_000, firstOfferAtMs: 1_000, lastOfferAtMs: 20_900, endedAtMs: 95_900 },
    loadAverage: { atStart: [1.2, 1.5, 1.7], atEnd: [2.1, 1.8, 1.75] },
    run: {
        wallMs: 97_300,
        sendWindow: {
            wallMs: 19_900.4,
            loopLag: { ticks: 1_800, p50Ms: 0.1, p95Ms: 2.04, p99Ms: 10.7, maxMs: 31, shareOfTicksOverOneMsLate: 0.12 },
            cpu: { scope: 'whole process, every thread', userMs: 18_000, systemMs: 1_721, coresBusy: 0.991 }
        },
        tail: {
            wallMs: 75_000.2,
            loopLag: { ticks: 7_100, p50Ms: 0.2, p95Ms: 4.96, p99Ms: 12.34, maxMs: 1_250, shareOfTicksOverOneMsLate: 0.305 },
            cpu: { scope: 'whole process, every thread', userMs: 40_000, systemMs: 8_000, coresBusy: 0.64 }
        }
    },
    report: {
        sends: {
            ...NO_FIGURES.sends,
            attempted: 200,
            byAcceptance: { ...NO_FIGURES.sends.byAcceptance, admitted: 180, 'pending-admission': 20 },
            latenessMs: { ...NO_DELAYS, count: 200, p50: 0.24, p95: 1.31, p99: 4, max: 12.5 }
        },
        delivery: {
            ...NO_FIGURES.delivery,
            handedToApplication: 31,
            handedMoreThanOnce: 4,
            largestHandOffMultiplicity: 3,
            pendingAdmissionHandedToApplication: 4,
            pendingAdmissionNeverHanded: 16,
            deliveredToEveryRecipient: 31,
            deliveredToAnyRecipient: 31,
            copiesExpected: 2_800,
            copiesRead: 434,
            copiesReadMoreThanOnce: 56
        },
        recipientDelays: {
            ...NO_FIGURES.recipientDelays,
            dueToFirstReadMs: { ...NO_DELAYS, count: 434, p50: 43.12, p95: 1_234.5, p99: 2_000, max: 2_100 },
            dueToFirstReadOverExpectedCopiesMs: { count: 2_800, p50: null, p95: null, p99: null }
        },
        receipts: {
            ...NO_FIGURES.receipts,
            expected: 200,
            complete: 23,
            timedOut: 158,
            admittedWithoutTerminal: 10,
            noReceipt: 9,
            offerToAdmittedMs: { ...NO_DELAYS, count: 191, p50: 180.04, p95: 2_800, p99: 3_000, max: 3_100 },
            offerToCompleteMs: { ...NO_DELAYS, count: 23, p50: 5_830.2, p95: 7_000, p99: 7_100, max: 7_100 }
        },
        controls: {
            byType: { nack: 12, repair: 12 },
            nacksByReason: { ...NO_FIGURES.controls.nacksByReason, gap: 12 },
            repairsByReason: { ...NO_FIGURES.controls.repairsByReason, 'missing-seq': 12 },
            sendsWithANack: 12,
            sendsWithARepairRequest: 12
        },
        beforeFirstControl: {
            tracksWithAControl: 5,
            sends: 37,
            copiesExpected: 518,
            copiesRead: 434,
            dueToFirstReadOverExpectedCopiesMs: { count: 518, p50: 45, p95: null, p99: null }
        },
        resends: {
            ...NO_FIGURES.resends,
            count: 582,
            byAcceptance: { ...NO_FIGURES.resends.byAcceptance, admitted: 2, duplicate: 580 },
            sendsResent: 190,
            byCause: {
                repair: {
                    ...NO_FIGURES.resends.byCause.repair,
                    count: 12,
                    byAcceptance: { ...NO_FIGURES.resends.byAcceptance, duplicate: 12 },
                    sendsResent: 12,
                    largestAttempt: 1
                },
                'first-hop': {
                    ...NO_FIGURES.resends.byCause['first-hop'],
                    count: 570,
                    byAcceptance: { ...NO_FIGURES.resends.byAcceptance, admitted: 2, duplicate: 568 },
                    sendsResent: 190,
                    largestAttempt: 3
                }
            }
        },
        acks: {
            ...NO_FIGURES.acks,
            offered: 434,
            byAcceptance: { ...NO_FIGURES.acks.byAcceptance, control: 434 },
            controlsNotHandled: 290
        },
        standIn: {
            sendsEnded: 197,
            endsByCause: {
                'first-hop-exhausted': 91,
                'terminal-receipt': 23,
                'terminal-nack': 0,
                'repair-budget-spent': 0,
                expired: 83
            },
            repairsDeclined: 14,
            repairsDeclinedByReason: { 'send-ended': 12, 'send-expired': 0, 'named-send-expired': 2 }
        },
        unmatched: NO_FIGURES.unmatched
    }
};

describe('toOrderedSendSummary', () => {
    it('prints sends, copies written of expected, the due-to-first-read over expected copies with \'not reached\' for a null, receipts by state and messages handed more than once', () => {
        expect(toOrderedSendSummary(STALLED_RUN)).toEqual([
            'ALM ordered-send cell: 5 publishers x 2 sends/s for 20 s; +5 ms nominal on the delayed database round trips; ' +
            'sender recovery client-stand-in; application pool 5 (API default 5)',
            'commit abc1234; observed 75.0 s past the last offer; run wall time 97.3 s; ' +
            'load average 1.20 at start, 2.10 at end',
            'sends offered: 200; the entry answered admitted 180, pending-admission 20',
            'offers that threw: none',
            'lateness of an offer against its due time: p50 0.2 ms, p95 1.3 ms, max 12.5 ms',
            'copies written to the recipient\'s socket: 434 of 2800 expected; ' +
            'sends written to every recipient 31, to at least one 31',
            'due time to first write, over the 2800 expected copies: p50 not reached, p95 not reached, p99 not reached',
            'due time to first write, over the 434 written copies: p50 43.1 ms, p95 1.23 s, max 2.10 s',
            'copies written more than once 56, ahead of a lower seq of their track 0, ' +
            'past a predecessor never written 0',
            'sends a server instance handed to its application subscriber: 31 of 200; more than once 4 ' +
            '(the most hand-offs of one send: 3); answered pending-admission and never handed 16',
            'receipts, of the 200 sends that expect one: complete 23, timed out 158, admitted only 10, none 9',
            'offer to admitted receipt: p50 180.0 ms, p95 2.80 s; offer to complete receipt: p50 5.83 s, p95 7.00 s',
            'ACKs the recipients offered: 434; the entry answered control 434, ' +
            '290 of them not handled by the instance offered',
            'controls the server sent its publishers: 12 nack (gap 12), 12 repair (missing-seq 12); ' +
            'sends that drew a nack 12, a repair request 12',
            'resends: repair 12 (answered duplicate 12), first-hop 570 (answered admitted 2, duplicate 568); ' +
            'sends offered again 190',
            'sends the stand-in ended: 197 (first-hop-exhausted 91, terminal-receipt 23, expired 83); ' +
            'repairs it declined for an ended or expired send: 14 (send-ended 12, named-send-expired 2)',
            'before each track\'s first control (5 of 5 tracks drew one): 37 sends, 434 of 518 copies written; ' +
            'due time to first write over expected copies p50 45.0 ms, p95 not reached',
            'send window: 19.9 s; event-loop lag p50 0.1 ms, p95 2.0 ms, p99 10.7 ms, max 31.0 ms, ' +
            '12.0% of ticks over 1 ms late; processor time of the whole process, every thread: 0.99 cores busy',
            'tail: 75.0 s; event-loop lag p50 0.2 ms, p95 5.0 ms, p99 12.3 ms, max 1.25 s, ' +
            '30.5% of ticks over 1 ms late; processor time of the whole process, every thread: 0.64 cores busy'
        ]);
    });

    it('prints a run that kept up without a control, a resend or a figure out of reach, and says its tree was dirty', () => {
        const keptUp: OrderedSendSummarySource = {
            ...STALLED_RUN,
            dirty: true,
            shape: { ...STALLED_RUN.shape, delayMs: 0, senderRecovery: 'none', applicationPoolMaxConnections: 10 },
            applicationPool: { effectiveMaxConnections: 10, apiV1DefaultMaxConnections: 5 },
            report: {
                ...STALLED_RUN.report,
                delivery: {
                    ...STALLED_RUN.report.delivery,
                    handedToApplication: 200,
                    handedMoreThanOnce: 0,
                    largestHandOffMultiplicity: 1,
                    pendingAdmissionNeverHanded: 0,
                    deliveredToEveryRecipient: 200,
                    deliveredToAnyRecipient: 200,
                    copiesRead: 2_800,
                    copiesReadMoreThanOnce: 0
                },
                recipientDelays: {
                    ...STALLED_RUN.report.recipientDelays,
                    dueToFirstReadMs: { ...NO_DELAYS, count: 2_800, p50: 43.12, p95: 64.96, p99: 80, max: 120 },
                    dueToFirstReadOverExpectedCopiesMs: { count: 2_800, p50: 43.12, p95: 64.96, p99: 80 }
                },
                receipts: { ...STALLED_RUN.report.receipts, complete: 200, timedOut: 0, admittedWithoutTerminal: 0, noReceipt: 0 },
                controls: NO_FIGURES.controls,
                beforeFirstControl: {
                    tracksWithAControl: 0,
                    sends: 200,
                    copiesExpected: 2_800,
                    copiesRead: 2_800,
                    dueToFirstReadOverExpectedCopiesMs: { count: 2_800, p50: 43.12, p95: 64.96, p99: 80 }
                },
                resends: NO_FIGURES.resends
            }
        };

        const lines = toOrderedSendSummary(keptUp);

        expect(lines).toHaveLength(18);
        expect(lines[0]).toBe(
            'ALM ordered-send cell: 5 publishers x 2 sends/s for 20 s; +0 ms nominal on the delayed database round trips; ' +
                'sender recovery none; application pool 10 (API default 5)'
        );
        expect(lines[1]).toBe(
            'commit abc1234 with uncommitted changes; observed 75.0 s past the last offer; run wall time 97.3 s; ' +
                'load average 1.20 at start, 2.10 at end'
        );
        expect(lines.slice(5, 8)).toEqual([
            'copies written to the recipient\'s socket: 2800 of 2800 expected; ' +
            'sends written to every recipient 200, to at least one 200',
            'due time to first write, over the 2800 expected copies: p50 43.1 ms, p95 65.0 ms, p99 80.0 ms',
            'due time to first write, over the 2800 written copies: p50 43.1 ms, p95 65.0 ms, max 120.0 ms'
        ]);
        expect(lines.slice(13, 16)).toEqual([
            'controls the server sent its publishers: none',
            'resends: none',
            'before each track\'s first control (0 of 5 tracks drew one): 200 sends, 2800 of 2800 copies written; ' +
            'due time to first write over expected copies p50 43.1 ms, p95 65.0 ms'
        ]);
    });

    it('prints what the run recorded beside its sends, and the delays no figure holds, only when there are any', () => {
        const withStrays: OrderedSendSummarySource = {
            ...STALLED_RUN,
            report: {
                ...STALLED_RUN.report,
                sends: {
                    ...STALLED_RUN.report.sends,
                    latenessMs: { ...STALLED_RUN.report.sends.latenessMs, unrecordedSamples: 1 }
                },
                recipientDelays: { ...STALLED_RUN.report.recipientDelays, copiesReadBeforeTheirOffer: 3 },
                receipts: {
                    ...STALLED_RUN.report.receipts,
                    offerToCompleteMs: { ...STALLED_RUN.report.receipts.offerToCompleteMs, unrecordedSamples: 2 }
                },
                unmatched: { ...NO_FIGURES.unmatched, arrivalsOfUnknownMessage: 2, unclassifiedControls: 1 }
            }
        };

        expect(toOrderedSendSummary(withStrays).slice(19)).toEqual([
            'recorded beside the sends the cell knows: arrivalsOfUnknownMessage 2, unclassifiedControls 1',
            'delays below zero, in no figure: sends.latenessMs 1, receipts.offerToCompleteMs 2',
            'copies written before their send\'s offer was read, in no delay figure: 3'
        ]);
    });

    it('says the stand-in ended and declined nothing when it did neither, and prints no such line for a run without one', () => {
        const nothingEnded: OrderedSendSummarySource = {
            ...STALLED_RUN,
            report: { ...STALLED_RUN.report, standIn: NO_FIGURES.standIn }
        };
        const withoutStandIn: OrderedSendSummarySource = {
            ...nothingEnded,
            shape: { ...STALLED_RUN.shape, senderRecovery: 'none' }
        };

        expect(toOrderedSendSummary(nothingEnded)[15]).toBe(
            'sends the stand-in ended: none; repairs it declined for an ended or expired send: none'
        );
        expect(toOrderedSendSummary(withoutStandIn).join('\n')).not.toContain('stand-in ended');
    });

    it('prints each kind of offer that threw with its count by error name and the first message under each name', () => {
        const corruption = 'Buffered inbound ordering slot lost its canonical message';
        const withThrownOffers: OrderedSendSummarySource = {
            ...STALLED_RUN,
            report: {
                ...STALLED_RUN.report,
                sends: {
                    ...STALLED_RUN.report.sends,
                    byAcceptance: { ...STALLED_RUN.report.sends.byAcceptance, admitted: 177, threw: 3 },
                    threwByErrorName: { ALAdmissionCorruptionError: 2, PostgresError: 1 },
                    firstThrownMessageByErrorName: { ALAdmissionCorruptionError: corruption, PostgresError: 'connection ended' }
                },
                resends: {
                    ...STALLED_RUN.report.resends,
                    threwByErrorName: { ALAdmissionCorruptionError: 4 },
                    firstThrownMessageByErrorName: { ALAdmissionCorruptionError: corruption }
                }
            }
        };

        const lines = toOrderedSendSummary(withThrownOffers);

        expect(lines[2]).toBe('sends offered: 200; the entry answered admitted 177, pending-admission 20, threw 3');
        expect(lines[3]).toBe(
            `offers that threw: sends ALAdmissionCorruptionError 2 ("${corruption}"), ` +
                `PostgresError 1 ("connection ended"); resends ALAdmissionCorruptionError 4 ("${corruption}")`
        );
    });

    it('says a delay has no sample when no send reached it', () => {
        const noReceiptRead: OrderedSendSummarySource = {
            ...STALLED_RUN,
            report: {
                ...STALLED_RUN.report,
                receipts: { ...STALLED_RUN.report.receipts, offerToAdmittedMs: NO_DELAYS, offerToCompleteMs: NO_DELAYS }
            }
        };

        expect(toOrderedSendSummary(noReceiptRead)[11]).toBe(
            'offer to admitted receipt: p50 no sample, p95 no sample; ' +
                'offer to complete receipt: p50 no sample, p95 no sample'
        );
    });
});
