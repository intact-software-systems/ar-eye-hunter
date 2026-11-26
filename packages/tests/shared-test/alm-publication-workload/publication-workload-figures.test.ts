import { describe, expect, it } from 'vitest';

import {
    toPublicationWorkloadFigures,
    type PublicationWorkloadRun
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/to-publication-workload-figures.ts';
import type { PublicationWorkloadParameters } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import {
    AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    AL_PUBLICATION_FIGURE_PERCENT_BOUNDS
} from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';

/** Three agents, one send every 500 ms for 30 seconds on rtc: 30,000 / 500 = 60 frames. */
const POINT: PublicationWorkloadParameters = {
    group: { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' },
    participantCount: 3,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 30_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.95,
    readyTimeoutMs: 45_000
};

/** The loop's own figure for 60 iterations over 30,260 ms: 59 x 1,000 / 30,260, to four places. */
const LOOP_RESULT = {
    commandId: 'publication-workload-publish',
    iterations: 60,
    childResultCount: 60,
    passed: 59,
    failed: 1,
    cancelled: false,
    pacing: {
        requestedIntervalMs: 500,
        requestedRateHz: 2,
        plannedIterations: 60,
        completedIterations: 60,
        elapsedMs: 30_260,
        achievedRateHz: 1.9498
    },
    results: []
};

const PUBLICATION_STAGE = {
    lanes: 1,
    streams: 1,
    staged: 0,
    stagedBytes: 0,
    limits: { maxStreams: 64, maxStagedValues: 1_000, maxStagedBytes: 4_194_304 },
    counters: { staged: 59, superseded: 0, expired: 0, refused: 0, cancelled: 0, admitted: 59, deferred: 0 },
    figures: {
        selectionAgeMs: {
            upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
            bucketCounts: [0, 0, 0, 0, 0, 30, 29, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            count: 59,
            sum: 3_100,
            min: 22,
            max: 98
        },
        selectionToAdmissionMs: {
            upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
            bucketCounts: [50, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            count: 59,
            sum: 40,
            min: 0,
            max: 2
        },
        drainMessagesPercent: {
            upperBounds: AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
            bucketCounts: [0, 59, 0, 0, 0, 0, 0],
            count: 59,
            sum: 737.5,
            min: 12.5,
            max: 12.5
        },
        drainBytesPercent: {
            upperBounds: AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
            bucketCounts: [59, 0, 0, 0, 0, 0, 0],
            count: 59,
            sum: 23.6,
            min: 0.4,
            max: 0.4
        },
        submittedOpportunities: 59,
        missedOpportunities: 0,
        unrecordedSamples: 0
    }
} satisfies ALOutboundPublicationStageReport;

const STATS_RESULT = { status: 'ready', rallar: { connected: true, alm: { publication: PUBLICATION_STAGE } } };

/**
 * The age buckets end at 1, 2, 5, 10, 20, 50, 100, 200 and 500 ms and on. Sixty samples: 4 up to 5 ms, 20 up to 10,
 * 28 up to 20, 5 up to 50, 2 up to 100 and 1 up to 200. Rank 30 lies in (10, 20], rank 57 in (20, 50] and rank 60 in
 * (100, 200], which the largest sample ends at 140.
 */
const FIRST_AGE_MS = {
    upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    bucketCounts: [0, 0, 4, 20, 28, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    count: 60,
    sum: 870,
    min: 3,
    max: 140
} satisfies BoundedHistogram;

/**
 * Fifty-seven samples: 10 up to 10 ms, 30 up to 20, 12 up to 50, 4 up to 100 and 1 up to 500. Rank 29 lies in
 * (10, 20], rank 55 in (50, 100] and rank 57 in (200, 500], which the largest sample ends at 420.
 */
const SECOND_AGE_MS = {
    upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    bucketCounts: [0, 0, 0, 10, 30, 12, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    count: 57,
    sum: 1_480,
    min: 6,
    max: 420
} satisfies BoundedHistogram;

const NO_AGE_MS = {
    upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    count: 0,
    sum: 0,
    min: null,
    max: null
} satisfies BoundedHistogram;

function toReceivedResult(observed: number, ageMs: ApiJsonObject, unrecordedSamples: number): ApiJsonObject {
    return {
        typeId: 'publication-workload.frame',
        count: 57,
        observed,
        absent: false,
        sampleAge: { from: 'sentAtEpochMs', ageMs, unrecordedSamples },
        received: []
    };
}

const RUN: PublicationWorkloadRun = {
    parameters: POINT,
    publisher: { loop: LOOP_RESULT, stats: STATS_RESULT },
    subscribers: [
        { agentId: 'agent-2', received: toReceivedResult(60, FIRST_AGE_MS, 0) },
        { agentId: 'agent-3', received: toReceivedResult(58, SECOND_AGE_MS, 1) }
    ]
};

interface UnreadableRun {
    readonly unreadable: string;
    readonly run: PublicationWorkloadRun;
    readonly paths: readonly string[];
}

const UNREADABLE_RUNS: readonly UnreadableRun[] = [
    {
        unreadable: 'a loop result that is no object',
        run: { ...RUN, publisher: { ...RUN.publisher, loop: 'cancelled' } },
        paths: [
            '$.publisher.loop.passed',
            '$.publisher.loop.pacing.completedIterations',
            '$.publisher.loop.pacing.elapsedMs'
        ]
    },
    {
        unreadable: 'a stats result that read no publication stage',
        run: { ...RUN, publisher: { ...RUN.publisher, stats: { status: 'ready', rallar: { connected: true } } } },
        paths: ['$.publisher.stats.rallar.alm.publication']
    },
    {
        unreadable: 'a publication stage with a negative holding',
        run: {
            ...RUN,
            publisher: {
                ...RUN.publisher,
                stats: { rallar: { alm: { publication: { ...PUBLICATION_STAGE, staged: -1 } } } }
            }
        },
        paths: ['$.publisher.stats.rallar.alm.publication.staged']
    },
    {
        unreadable: 'a count that named no ageFrom',
        run: {
            ...RUN,
            subscribers: [RUN.subscribers[0], { agentId: 'agent-3', received: { observed: 58, received: [] } }]
        },
        paths: ['$.subscribers[1].received.sampleAge']
    },
    {
        unreadable: 'a sample age on other bounds, read from another payload field',
        run: {
            ...RUN,
            subscribers: [{
                agentId: 'agent-2',
                received: {
                    observed: 1,
                    sampleAge: {
                        from: 'seq',
                        ageMs: { upperBounds: [10, 100], bucketCounts: [1, 0, 0], count: 1, sum: 4, min: 4, max: 4 },
                        unrecordedSamples: 0
                    }
                }
            }]
        },
        paths: ['$.subscribers[0].received.sampleAge.from', '$.subscribers[0].received.sampleAge.ageMs.upperBounds']
    },
    {
        unreadable: 'a count that differs from its recorded and unrecorded samples together',
        run: { ...RUN, subscribers: [{ agentId: 'agent-2', received: toReceivedResult(62, FIRST_AGE_MS, 1) }] },
        paths: ['$.subscribers[0].received.observed']
    },
    {
        unreadable: 'a point that breaks a bound of the family',
        run: { ...RUN, parameters: { ...POINT, windowMs: 30_250 } },
        paths: ['$.parameters.windowMs']
    },
    {
        unreadable: 'several results at once',
        run: {
            ...RUN,
            publisher: {
                loop: { ...LOOP_RESULT, passed: '59', pacing: { ...LOOP_RESULT.pacing, achievedRateHz: 'paced' } },
                stats: {}
            },
            subscribers: [RUN.subscribers[0], { agentId: 'agent-3', received: { observed: 58 } }]
        },
        paths: [
            '$.publisher.loop.passed',
            '$.publisher.loop.pacing.achievedRateHz',
            '$.publisher.stats.rallar.alm.publication',
            '$.subscribers[1].received.sampleAge'
        ]
    }
];

describe('toPublicationWorkloadFigures', () => {
    it('repeats the point as configured, and reports the achieved rate and each subscriber\'s age ranges as measured', () => {
        expect(toPublicationWorkloadFigures(RUN).right).toEqual({
            configured: {
                parameters: POINT,
                // 1,000 / 500 = 2 Hz; 3 - 1 = 2 subscribers; 57 of 60 is 0.95; 60 x 2 = 120 fan-out messages.
                plan: {
                    frameCount: 60,
                    configuredRateHz: 2,
                    subscriberCount: 2,
                    expectedInboundMessages: 60,
                    minExpectedInboundMessages: 57,
                    minAcceptedSends: 57,
                    logicalFanoutMessages: 120
                }
            },
            measured: {
                publisher: {
                    acceptedSends: 59,
                    completedIterations: 60,
                    elapsedMs: 30_260,
                    achievedRateHz: 1.9498,
                    publicationStage: PUBLICATION_STAGE
                },
                subscribers: [
                    {
                        agentId: 'agent-2',
                        observed: 60,
                        unrecordedSamples: 0,
                        sampleAgeMs: {
                            kind: 'recorded',
                            count: 60,
                            min: 3,
                            max: 140,
                            p50: { atLeast: 10, atMost: 20 },
                            p95: { atLeast: 20, atMost: 50 },
                            p99: { atLeast: 100, atMost: 140 }
                        }
                    },
                    {
                        agentId: 'agent-3',
                        observed: 58,
                        unrecordedSamples: 1,
                        sampleAgeMs: {
                            kind: 'recorded',
                            count: 57,
                            min: 6,
                            max: 420,
                            p50: { atLeast: 10, atMost: 20 },
                            p95: { atLeast: 50, atMost: 100 },
                            p99: { atLeast: 200, atMost: 420 }
                        }
                    }
                ]
            }
        });
    });

    it.each(UNREADABLE_RUNS)('names every field it cannot read of $unreadable', ({ run, paths }) => {
        const figures = toPublicationWorkloadFigures(run);

        expect(figures.right).toBeUndefined();
        expect(figures.left?.map((issue) => issue.slice(0, issue.indexOf(' ')))).toEqual(paths);
    });

    it('says that a subscriber recorded no age, and reports no zero in its place', () => {
        const figures = toPublicationWorkloadFigures({
            ...RUN,
            subscribers: [{ agentId: 'agent-2', received: toReceivedResult(3, NO_AGE_MS, 3) }]
        });

        expect(figures.right?.measured.subscribers).toEqual([
            { agentId: 'agent-2', observed: 3, unrecordedSamples: 3, sampleAgeMs: { kind: 'no-samples' } }
        ]);
    });

    it('reports a subscriber that observed more copies than the publisher had frames as it observed them', () => {
        // One copy more than the 60 frames, in the bucket up to 20 ms: 4 + 20 + 29 + 5 + 2 + 1 = 61.
        const ageMs = {
            ...FIRST_AGE_MS,
            bucketCounts: [0, 0, 4, 20, 29, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
            count: 61,
            sum: 885
        } satisfies BoundedHistogram;

        const figures = toPublicationWorkloadFigures({
            ...RUN,
            subscribers: [{ agentId: 'agent-2', received: toReceivedResult(61, ageMs, 0) }]
        });

        expect(figures.right?.configured.plan.expectedInboundMessages).toBe(60);
        expect(figures.right?.measured.subscribers[0]).toMatchObject({ observed: 61, sampleAgeMs: { count: 61 } });
    });
});
