import { describe, expect, it } from 'vitest';

import type { PublicationWorkloadPublisherResults } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/decode-publication-workload-publisher-figures.ts';
import {
    toPublicationWorkloadFigures,
    type PublicationWorkloadRoomResults,
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

const GROUP = { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' };
const SECOND_GROUP = { ...GROUP, groupId: 'workload-room-2' };

/** One room of three agents, one of them sending every 500 ms for 30 seconds on rtc: 30,000 / 500 = 60 frames. */
const POINT: PublicationWorkloadParameters = {
    groups: [GROUP],
    participantCount: 3,
    publisherCount: 1,
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

/**
 * Sixty iterations of one send each, 59 of them submitted. The loop's own rate for them over 30,260 ms is its 59
 * intervals: 59 x 1,000 / 30,260, to four places.
 */
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

/** Twelve samples, all above 5 and up to 10 ms. */
const AGES_UP_TO_10_MS = {
    upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    bucketCounts: [0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    count: 12,
    sum: 96,
    min: 6,
    max: 10
} satisfies BoundedHistogram;

/** Eight samples: seven above 50 and up to 100 ms, and one above 200 and up to 500. */
const AGES_ABOVE_50_MS = {
    upperBounds: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    bucketCounts: [0, 0, 0, 0, 0, 0, 7, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    count: 8,
    sum: 945,
    min: 60,
    max: 420
} satisfies BoundedHistogram;

const PUBLISHER: PublicationWorkloadPublisherResults = {
    agentId: 'agent-1',
    loop: LOOP_RESULT,
    stats: STATS_RESULT
};

const ROOM: PublicationWorkloadRoomResults = {
    group: GROUP,
    publishers: [PUBLISHER],
    subscribers: [
        { agentId: 'agent-2', received: toReceivedResult(60, FIRST_AGE_MS, 0) },
        { agentId: 'agent-3', received: toReceivedResult(58, SECOND_AGE_MS, 1) }
    ]
};

const RUN: PublicationWorkloadRun = { parameters: POINT, rooms: [ROOM] };

/** The same three agents with two of them publishing, which leaves one subscriber. */
const TWO_PUBLISHER_POINT: PublicationWorkloadParameters = { ...POINT, publisherCount: 2 };

/** The same point in two rooms at once. */
const TWO_ROOM_POINT: PublicationWorkloadParameters = { ...POINT, groups: [GROUP, SECOND_GROUP] };

const SECOND_ROOM: PublicationWorkloadRoomResults = {
    group: SECOND_GROUP,
    publishers: [{ ...PUBLISHER, agentId: 'agent-4' }],
    subscribers: [
        { agentId: 'agent-5', received: toReceivedResult(13, AGES_UP_TO_10_MS, 1) },
        { agentId: 'agent-6', received: toReceivedResult(8, AGES_ABOVE_50_MS, 0) }
    ]
};

/** A run of the point whose one room left these results. */
function toRunOfRoom(room: PublicationWorkloadRoomResults): PublicationWorkloadRun {
    return { parameters: POINT, rooms: [room] };
}

interface UnreadableRun {
    readonly unreadable: string;
    readonly run: PublicationWorkloadRun;
    readonly paths: readonly string[];
}

const UNREADABLE_RUNS: readonly UnreadableRun[] = [
    {
        unreadable: 'a loop result that is no object',
        run: toRunOfRoom({ ...ROOM, publishers: [{ ...PUBLISHER, loop: 'cancelled' }] }),
        paths: [
            '$.rooms[0].publishers[0].loop.passed',
            '$.rooms[0].publishers[0].loop.childResultCount',
            '$.rooms[0].publishers[0].loop.pacing.completedIterations',
            '$.rooms[0].publishers[0].loop.pacing.elapsedMs'
        ]
    },
    {
        unreadable: 'a loop that ran 61 children in its 60 iterations, so not one send per iteration',
        run: toRunOfRoom({ ...ROOM, publishers: [{ ...PUBLISHER, loop: { ...LOOP_RESULT, childResultCount: 61 } }] }),
        paths: ['$.rooms[0].publishers[0].loop.childResultCount']
    },
    {
        unreadable: 'a loop whose elapsed time is negative',
        run: toRunOfRoom({
            ...ROOM,
            publishers: [{ ...PUBLISHER, loop: { ...LOOP_RESULT, pacing: { ...LOOP_RESULT.pacing, elapsedMs: -1 } } }]
        }),
        paths: ['$.rooms[0].publishers[0].loop.pacing.elapsedMs']
    },
    {
        unreadable: 'a stats result that read no publication stage',
        run: toRunOfRoom({ ...ROOM, publishers: [{ ...PUBLISHER, stats: { status: 'ready', rallar: { connected: true } } }] }),
        paths: ['$.rooms[0].publishers[0].stats.rallar.alm.publication']
    },
    {
        unreadable: 'a publication stage with a negative holding',
        run: toRunOfRoom({
            ...ROOM,
            publishers: [{
                ...PUBLISHER,
                stats: { rallar: { alm: { publication: { ...PUBLICATION_STAGE, staged: -1 } } } }
            }]
        }),
        paths: ['$.rooms[0].publishers[0].stats.rallar.alm.publication.staged']
    },
    {
        unreadable: 'a subscriber whose count left no result value',
        run: toRunOfRoom({ ...ROOM, subscribers: [{ agentId: 'agent-2', received: undefined }, ROOM.subscribers[1]] }),
        paths: ['$.rooms[0].subscribers[0].received.observed', '$.rooms[0].subscribers[0].received.sampleAge']
    },
    {
        unreadable: 'a sample age whose unrecorded samples are no count',
        run: toRunOfRoom({
            ...ROOM,
            subscribers: [{ agentId: 'agent-2', received: toReceivedResult(60, FIRST_AGE_MS, -1) }, ROOM.subscribers[1]]
        }),
        paths: ['$.rooms[0].subscribers[0].received.sampleAge.unrecordedSamples']
    },
    {
        unreadable: 'a count that named no ageFrom',
        run: toRunOfRoom({
            ...ROOM,
            subscribers: [ROOM.subscribers[0], { agentId: 'agent-3', received: { observed: 58, received: [] } }]
        }),
        paths: ['$.rooms[0].subscribers[1].received.sampleAge']
    },
    {
        unreadable: 'a sample age on other bounds, read from another payload field',
        run: toRunOfRoom({
            ...ROOM,
            subscribers: [
                {
                    agentId: 'agent-2',
                    received: {
                        observed: 1,
                        sampleAge: {
                            from: 'seq',
                            ageMs: { upperBounds: [10, 100], bucketCounts: [1, 0, 0], count: 1, sum: 4, min: 4, max: 4 },
                            unrecordedSamples: 0
                        }
                    }
                },
                ROOM.subscribers[1]
            ]
        }),
        paths: [
            '$.rooms[0].subscribers[0].received.sampleAge.from',
            '$.rooms[0].subscribers[0].received.sampleAge.ageMs.upperBounds'
        ]
    },
    {
        unreadable: 'a count that differs from its recorded and unrecorded samples together',
        run: toRunOfRoom({
            ...ROOM,
            subscribers: [{ agentId: 'agent-2', received: toReceivedResult(62, FIRST_AGE_MS, 1) }, ROOM.subscribers[1]]
        }),
        paths: ['$.rooms[0].subscribers[0].received.observed']
    },
    {
        unreadable: 'a point that breaks a bound of the family',
        run: { ...RUN, parameters: { ...POINT, windowMs: 30_250 } },
        paths: ['$.parameters.windowMs']
    },
    {
        unreadable: 'several results at once',
        run: toRunOfRoom({
            ...ROOM,
            publishers: [{
                agentId: 'agent-1',
                loop: { ...LOOP_RESULT, passed: '59', pacing: { ...LOOP_RESULT.pacing, achievedRateHz: 'paced' } },
                stats: {}
            }],
            subscribers: [ROOM.subscribers[0], { agentId: 'agent-3', received: { observed: 58 } }]
        }),
        paths: [
            '$.rooms[0].publishers[0].loop.passed',
            '$.rooms[0].publishers[0].loop.pacing.achievedRateHz',
            '$.rooms[0].publishers[0].stats.rallar.alm.publication',
            '$.rooms[0].subscribers[1].received.sampleAge'
        ]
    },
    {
        unreadable: 'a second publisher whose stats read no publication stage',
        run: {
            parameters: TWO_PUBLISHER_POINT,
            rooms: [{
                ...ROOM,
                publishers: [PUBLISHER, { ...PUBLISHER, agentId: 'agent-4', stats: {} }],
                subscribers: [ROOM.subscribers[0]]
            }]
        },
        paths: ['$.rooms[0].publishers[1].stats.rallar.alm.publication']
    },
    {
        unreadable: 'the results of two rooms for a point of one room, the second the first\'s again',
        run: { parameters: POINT, rooms: [ROOM, ROOM] },
        paths: [
            '$.rooms',
            '$.rooms[1].publishers[0].agentId',
            '$.rooms[1].subscribers[0].agentId',
            '$.rooms[1].subscribers[1].agentId'
        ]
    },
    {
        unreadable: 'the results of no room',
        run: { parameters: POINT, rooms: [] },
        paths: ['$.rooms']
    },
    {
        unreadable: 'one subscriber result for a point of two subscribers',
        run: toRunOfRoom({ ...ROOM, subscribers: [ROOM.subscribers[0]] }),
        paths: ['$.rooms[0].subscribers']
    },
    {
        unreadable: 'one subscriber result of two, and that one with no result value: the missing result, then the unread fields',
        run: toRunOfRoom({ ...ROOM, subscribers: [{ agentId: 'agent-2', received: undefined }] }),
        paths: [
            '$.rooms[0].subscribers',
            '$.rooms[0].subscribers[0].received.observed',
            '$.rooms[0].subscribers[0].received.sampleAge'
        ]
    },
    {
        unreadable: 'three subscriber results for a point of two subscribers',
        run: toRunOfRoom({
            ...ROOM,
            subscribers: [...ROOM.subscribers, { agentId: 'agent-4', received: toReceivedResult(60, FIRST_AGE_MS, 0) }]
        }),
        paths: ['$.rooms[0].subscribers']
    },
    {
        unreadable: 'no publisher result',
        run: toRunOfRoom({ ...ROOM, publishers: [] }),
        paths: ['$.rooms[0].publishers']
    },
    {
        unreadable: 'two publisher results for a point of one publisher',
        run: toRunOfRoom({ ...ROOM, publishers: [PUBLISHER, { ...PUBLISHER, agentId: 'agent-4' }] }),
        paths: ['$.rooms[0].publishers']
    },
    {
        unreadable: 'one subscriber\'s result given twice, which would count its messages twice',
        run: toRunOfRoom({ ...ROOM, subscribers: [ROOM.subscribers[0], ROOM.subscribers[0]] }),
        paths: ['$.rooms[0].subscribers[1].agentId']
    },
    {
        unreadable: 'one publisher\'s result given twice in a point of two publishers',
        run: {
            parameters: TWO_PUBLISHER_POINT,
            rooms: [{ ...ROOM, publishers: [PUBLISHER, PUBLISHER], subscribers: [ROOM.subscribers[0]] }]
        },
        paths: ['$.rooms[0].publishers[1].agentId']
    },
    {
        unreadable: 'an agent named as a subscriber of two rooms, which would count its messages twice for the point',
        run: {
            parameters: TWO_ROOM_POINT,
            rooms: [ROOM, { ...SECOND_ROOM, subscribers: [ROOM.subscribers[0], SECOND_ROOM.subscribers[1]] }]
        },
        paths: ['$.rooms[1].subscribers[0].agentId']
    },
    {
        unreadable: 'an agent named three times, as a publisher and a subscriber of one room and as a publisher of another',
        run: {
            parameters: TWO_ROOM_POINT,
            rooms: [
                { ...ROOM, subscribers: [{ ...ROOM.subscribers[0], agentId: 'agent-1' }, ROOM.subscribers[1]] },
                { ...SECOND_ROOM, publishers: [PUBLISHER] }
            ]
        },
        paths: ['$.rooms[0].subscribers[0].agentId', '$.rooms[1].publishers[0].agentId']
    },
    {
        unreadable: 'the results of one room for a point of two rooms',
        run: { parameters: TWO_ROOM_POINT, rooms: [ROOM] },
        paths: ['$.rooms']
    },
    {
        unreadable: 'a room whose results name a group the point does not have',
        run: toRunOfRoom({ ...ROOM, group: SECOND_GROUP }),
        paths: ['$.rooms[0].group']
    },
    {
        unreadable: 'the rooms of a two-room point in the other order than its groups',
        run: { parameters: TWO_ROOM_POINT, rooms: [SECOND_ROOM, ROOM] },
        paths: ['$.rooms[0].group', '$.rooms[1].group']
    },
    {
        unreadable: 'the second room of a two-room point under the first room\'s group',
        run: { parameters: TWO_ROOM_POINT, rooms: [ROOM, { ...SECOND_ROOM, group: GROUP }] },
        paths: ['$.rooms[1].group']
    },
    {
        // One agent leaves no subscriber, and the agents are the wrong value: a room has at least 2.
        unreadable: 'a point of one agent, which its two subscriber results are then not counted against',
        run: { ...RUN, parameters: { ...POINT, participantCount: 1 } },
        paths: ['$.parameters.participantCount']
    }
];

describe('toPublicationWorkloadFigures', () => {
    it('repeats the point as configured, and reports as measured its room: the publisher\'s loop and stage, each subscriber\'s age ranges, and what was delivered', () => {
        // The 117 ages of both subscribers, counted up bucket by bucket: 4 up to 5 ms, 34 up to 10, 92 up to 20, 109 up to
        // 50, 115 up to 100, 116 up to 200 and 117 up to 500. Rank 59 lies in (10, 20], rank 112 in (50, 100] and rank
        // 116 in (100, 200]. 60 + 58 = 118 messages, one of them without an age.
        const delivered = {
            subscriberCount: 2,
            observed: 118,
            unrecordedSamples: 1,
            sampleAgeMs: {
                kind: 'recorded',
                count: 117,
                min: 3,
                max: 420,
                p50: { atLeast: 10, atMost: 20 },
                p95: { atLeast: 50, atMost: 100 },
                p99: { atLeast: 100, atMost: 200 }
            }
        };

        expect(toPublicationWorkloadFigures(RUN).right).toEqual({
            configured: {
                parameters: POINT,
                // 1,000 / 500 = 2 Hz; one room of 3 agents; 3 - 1 = 2 subscribers; 57 of 60 is 0.95; 60 x 2 = 120 fan-out
                // messages.
                plan: {
                    frameCount: 60,
                    configuredRateHz: 2,
                    roomCount: 1,
                    agentCount: 3,
                    subscriberCount: 2,
                    expectedAdmissions: 60,
                    expectedInboundMessages: 60,
                    minExpectedInboundMessages: 57,
                    minAcceptedSends: 57,
                    logicalFanoutMessages: 120
                }
            },
            measured: {
                rooms: [{
                    group: { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' },
                    publishers: [{
                        agentId: 'agent-1',
                        submittedSends: 59,
                        completedIterations: 60,
                        elapsedMs: 30_260,
                        achievedIterationRateHz: 1.9498,
                        publicationStage: PUBLICATION_STAGE
                    }],
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
                    ],
                    delivered
                }],
                delivered
            }
        });
    });

    it('reports one delivered sample age for the room and for the point: both subscribers\' histograms merged, their messages and unrecorded samples added', () => {
        const figures = toPublicationWorkloadFigures(toRunOfRoom({
            ...ROOM,
            subscribers: [
                { agentId: 'agent-2', received: toReceivedResult(13, AGES_UP_TO_10_MS, 1) },
                { agentId: 'agent-3', received: toReceivedResult(8, AGES_ABOVE_50_MS, 0) }
            ]
        }));

        // Twenty ages: 12 up to 10 ms, 7 up to 100 and 1 up to 500. Rank 10 lies in (5, 10], which the smallest sample
        // starts at 6, rank 19 in (50, 100] and rank 20 in (200, 500], which the largest sample ends at 420. 13 + 8 = 21
        // messages, one of them without an age.
        const delivered = {
            subscriberCount: 2,
            observed: 21,
            unrecordedSamples: 1,
            sampleAgeMs: {
                kind: 'recorded',
                count: 20,
                min: 6,
                max: 420,
                p50: { atLeast: 6, atMost: 10 },
                p95: { atLeast: 50, atMost: 100 },
                p99: { atLeast: 200, atMost: 420 }
            }
        };
        expect(figures.left).toBeUndefined();
        expect(figures.right?.measured.rooms[0].delivered).toEqual(delivered);
        expect(figures.right?.measured.delivered).toEqual(delivered);
    });

    it.each(UNREADABLE_RUNS)('names every field it cannot read of $unreadable', ({ run, paths }) => {
        const figures = toPublicationWorkloadFigures(run);

        expect(figures.right).toBeUndefined();
        expect(figures.left?.map((issue) => issue.slice(0, issue.indexOf(' ')))).toEqual(paths);
    });

    it('reads the results of both publishers of a two-publisher point, in the order the run gives them', () => {
        const figures = toPublicationWorkloadFigures({
            parameters: TWO_PUBLISHER_POINT,
            rooms: [{
                ...ROOM,
                publishers: [PUBLISHER, { ...PUBLISHER, agentId: 'agent-4', loop: { ...LOOP_RESULT, passed: 60, failed: 0 } }],
                subscribers: [ROOM.subscribers[0]]
            }]
        });

        expect(figures.left).toBeUndefined();
        // 3 - 2 = 1 subscriber, which hears both publishers: 60 x 2 = 120 messages, 114 of them at 0.95.
        expect(figures.right?.configured.plan)
            .toMatchObject({ subscriberCount: 1, expectedInboundMessages: 120, minExpectedInboundMessages: 114 });
        expect(figures.right?.measured.rooms[0].publishers.map(({ agentId, submittedSends }) => ({ agentId, submittedSends })))
            .toEqual([{ agentId: 'agent-1', submittedSends: 59 }, { agentId: 'agent-4', submittedSends: 60 }]);
        expect(figures.right?.measured.rooms[0].delivered.subscriberCount).toBe(1);
    });

    it('reads a loop of one iteration, which has no interval and so states no rate, as a rate of null', () => {
        const figures = toPublicationWorkloadFigures(toRunOfRoom({
            ...ROOM,
            publishers: [{
                ...PUBLISHER,
                loop: {
                    ...LOOP_RESULT,
                    iterations: 1,
                    childResultCount: 1,
                    passed: 1,
                    failed: 0,
                    pacing: { requestedIntervalMs: 500, requestedRateHz: 2, plannedIterations: 60, completedIterations: 1, elapsedMs: 12 }
                }
            }]
        }));

        expect(figures.left).toBeUndefined();
        expect(figures.right?.measured.rooms[0].publishers).toEqual([{
            agentId: 'agent-1',
            submittedSends: 1,
            completedIterations: 1,
            elapsedMs: 12,
            achievedIterationRateHz: null,
            publicationStage: PUBLICATION_STAGE
        }]);
    });

    it('reports each room of a two-room point under the group its results name, and one delivered sample age over the subscribers of both rooms', () => {
        const figures = toPublicationWorkloadFigures({ parameters: TWO_ROOM_POINT, rooms: [ROOM, SECOND_ROOM] });

        expect(figures.left).toBeUndefined();
        expect(figures.right?.configured.plan).toMatchObject({ roomCount: 2, agentCount: 6, logicalFanoutMessages: 240 });
        expect(
            figures.right?.measured.rooms.map(({ group, publishers, delivered }) => ({
                group,
                publisherAgentIds: publishers.map((publisher) => publisher.agentId),
                delivered: { subscriberCount: delivered.subscriberCount, observed: delivered.observed }
            }))
        ).toEqual([
            { group: GROUP, publisherAgentIds: ['agent-1'], delivered: { subscriberCount: 2, observed: 118 } },
            { group: SECOND_GROUP, publisherAgentIds: ['agent-4'], delivered: { subscriberCount: 2, observed: 21 } }
        ]);
        // The 117 ages of the first room and the 20 of the second, counted up bucket by bucket: 4 up to 5 ms, 46 up to
        // 10, 104 up to 20, 121 up to 50, 134 up to 100, 135 up to 200 and 137 up to 500. Rank 69 lies in (10, 20], rank
        // 131 in (50, 100] and rank 136 in (200, 500], which the largest sample ends at 420. 118 + 21 = 139 messages,
        // two of them without an age.
        expect(figures.right?.measured.delivered).toEqual({
            subscriberCount: 4,
            observed: 139,
            unrecordedSamples: 2,
            sampleAgeMs: {
                kind: 'recorded',
                count: 137,
                min: 3,
                max: 420,
                p50: { atLeast: 10, atMost: 20 },
                p95: { atLeast: 50, atMost: 100 },
                p99: { atLeast: 200, atMost: 420 }
            }
        });
    });

    it('says that subscribers recorded no age, each and together, and reports no zero in its place', () => {
        const figures = toPublicationWorkloadFigures(toRunOfRoom({
            ...ROOM,
            subscribers: [
                { agentId: 'agent-2', received: toReceivedResult(3, NO_AGE_MS, 3) },
                { agentId: 'agent-3', received: toReceivedResult(2, NO_AGE_MS, 2) }
            ]
        }));

        // 3 + 2 = 5 messages, none of them with an age.
        const delivered = { subscriberCount: 2, observed: 5, unrecordedSamples: 5, sampleAgeMs: { kind: 'no-samples' } };
        expect(figures.right?.measured.rooms[0].subscribers).toEqual([
            { agentId: 'agent-2', observed: 3, unrecordedSamples: 3, sampleAgeMs: { kind: 'no-samples' } },
            { agentId: 'agent-3', observed: 2, unrecordedSamples: 2, sampleAgeMs: { kind: 'no-samples' } }
        ]);
        expect(figures.right?.measured.rooms[0].delivered).toEqual(delivered);
        expect(figures.right?.measured.delivered).toEqual(delivered);
    });

    it('reports a subscriber that observed more copies than the publisher had frames as it observed them', () => {
        // One copy more than the 60 frames, in the bucket up to 20 ms: 4 + 20 + 29 + 5 + 2 + 1 = 61.
        const ageMs = {
            ...FIRST_AGE_MS,
            bucketCounts: [0, 0, 4, 20, 29, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
            count: 61,
            sum: 885
        } satisfies BoundedHistogram;

        const figures = toPublicationWorkloadFigures(toRunOfRoom({
            ...ROOM,
            subscribers: [{ agentId: 'agent-2', received: toReceivedResult(61, ageMs, 0) }, ROOM.subscribers[1]]
        }));

        expect(figures.right?.configured.plan.expectedInboundMessages).toBe(60);
        expect(figures.right?.measured.rooms[0].subscribers[0])
            .toMatchObject({ observed: 61, sampleAgeMs: { count: 61 } });
    });
});
