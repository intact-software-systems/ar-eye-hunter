import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { computePublicationWorkloadPlan } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/compute-publication-workload-plan.ts';
import {
    PUBLICATION_WORKLOAD_SENT_AT_FIELD,
    toPublicationWorkloadPayload
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/to-publication-workload-payload.ts';
import {
    validatePublicationWorkloadParameters,
    type PublicationWorkloadParameters
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

const GROUP = { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' };

/** One room of 15 agents, one of them sending every 500 ms for 5 minutes on rtc: 300,000 / 500 = 600 frames. */
const POINT: PublicationWorkloadParameters = {
    groups: [GROUP],
    participantCount: 15,
    publisherCount: 1,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 300_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.99,
    readyTimeoutMs: 45_000,
    loss: { kind: 'none' }
};

const UNKNOWN_CARRIER: string = 'sctp';
const UNKNOWN_LOSS_KIND: string = 'scripted';

/** The conformance lane's seeded loss: a quarter of the frames, from seed 7. */
const QUARTER_LOSS = { kind: 'seeded', ratio: 0.25, seed: 7 } as const;

/** Seed 11 at a quarter passes its first six draws and drops its seventh. */
const LATE_FIRST_DROP_LOSS = { kind: 'seeded', ratio: 0.25, seed: 11 } as const;

/** One room of three agents, one of them sending every 500 ms for 30 seconds on ws under a quarter loss: 60 frames. */
const WS_LOSS_POINT: PublicationWorkloadParameters = {
    ...POINT,
    participantCount: 3,
    carrier: 'ws',
    windowMs: 30_000,
    minSendSuccessRatio: 0.95,
    loss: QUARTER_LOSS
};

function toRooms(roomCount: number): readonly (typeof GROUP)[] {
    return Array.from({ length: roomCount }, (_, index) => ({ ...GROUP, groupId: `workload-room-${index + 1}` }));
}

interface BrokenBound {
    readonly bound: string;
    readonly change: Partial<PublicationWorkloadParameters>;
    readonly issue: Pick<RallarValidationIssue, 'path' | 'code'>;
}

const BROKEN_BOUNDS: readonly BrokenBound[] = [
    {
        bound: '2,001 frames',
        change: { windowMs: 1_000_500 },
        issue: { path: '$.windowMs', code: 'frame-count-above-limit' }
    },
    {
        bound: 'an unknown carrier',
        change: { carrier: UNKNOWN_CARRIER as AlmConformanceCarrier },
        issue: { path: '$.carrier', code: 'invalid-carrier' }
    },
    {
        bound: 'a payload above drain.bytes',
        change: { publication: { ...POINT.publication, drain: { messages: 8, bytes: 200 } } },
        issue: { path: '$.payloadBytes', code: 'payload-bytes-above-drain-bytes' }
    },
    {
        bound: 'a non-integer TTL',
        change: { ttlMs: 2.5 },
        issue: { path: '$.ttlMs', code: 'invalid-ttl-ms' }
    },
    {
        bound: 'a policy issue arriving under $.publication.*',
        change: { publication: { ...POINT.publication, retainNewest: 0 } },
        issue: { path: '$.publication.retainNewest', code: 'invalid-retain-newest' }
    },
    {
        bound: '51 agents',
        change: { participantCount: 51 },
        issue: { path: '$.participantCount', code: 'invalid-participant-count' }
    },
    {
        bound: 'no publisher',
        change: { publisherCount: 0 },
        issue: { path: '$.publisherCount', code: 'invalid-publisher-count' }
    },
    {
        bound: 'one and a half publishers',
        change: { publisherCount: 1.5 },
        issue: { path: '$.publisherCount', code: 'invalid-publisher-count' }
    },
    {
        bound: '15 publishers among 15 agents, which leaves no subscriber',
        change: { publisherCount: 15 },
        issue: { path: '$.publisherCount', code: 'publisher-count-leaves-no-subscriber' }
    },
    {
        // The one publisher is as many as the agents, and the agents are the wrong value: a room has at least 2.
        bound: 'one agent, which the publishers are then not held to',
        change: { participantCount: 1 },
        issue: { path: '$.participantCount', code: 'invalid-participant-count' }
    },
    {
        bound: 'a zero interval, which leaves the window nothing to be a multiple of',
        change: { publishIntervalMs: 0 },
        issue: { path: '$.publishIntervalMs', code: 'invalid-publish-interval-ms' }
    },
    {
        bound: 'a zero window',
        change: { windowMs: 0 },
        issue: { path: '$.windowMs', code: 'invalid-window-ms' }
    },
    {
        // {"seq":2000,"sentAtEpochMs":1802088000000,"pad":""} is 51 bytes; the 600-frame template is 50.
        bound: 'a payload one byte under the 2,000-frame template',
        change: { windowMs: 1_000_000, payloadBytes: 50 },
        issue: { path: '$.payloadBytes', code: 'payload-bytes-below-template-minimum' }
    },
    {
        bound: 'a payload one byte above the 65,536-byte message limit',
        change: {
            payloadBytes: 65_537,
            publication: { ...POINT.publication, drain: { messages: 8, bytes: 131_072 } }
        },
        issue: { path: '$.payloadBytes', code: 'payload-bytes-above-message-limit' }
    },
    {
        bound: 'a send success ratio of zero',
        change: { minSendSuccessRatio: 0 },
        issue: { path: '$.minSendSuccessRatio', code: 'invalid-min-send-success-ratio' }
    },
    {
        bound: 'a zero ready timeout',
        change: { readyTimeoutMs: 0 },
        issue: { path: '$.readyTimeoutMs', code: 'invalid-ready-timeout-ms' }
    },
    {
        bound: 'a zero TTL',
        change: { ttlMs: 0 },
        issue: { path: '$.ttlMs', code: 'invalid-ttl-ms' }
    },
    {
        bound: 'a receive ratio that is not a number',
        change: { minReceiveRatio: Number.NaN },
        issue: { path: '$.minReceiveRatio', code: 'invalid-min-receive-ratio' }
    },
    {
        bound: 'a group with an empty group id',
        change: { groups: [{ ...GROUP, groupId: '' }] },
        issue: { path: '$.groups[0].groupId', code: 'required' }
    },
    {
        bound: 'no group',
        change: { groups: [] },
        issue: { path: '$.groups', code: 'invalid-groups' }
    },
    {
        bound: 'two equal groups',
        change: { groups: [GROUP, { ...GROUP }] },
        issue: { path: '$.groups[1]', code: 'duplicate-group' }
    },
    {
        bound: 'a second group in another workspace than the first',
        change: { groups: [GROUP, { ...GROUP, workspaceId: 'other-workspace' }] },
        issue: { path: '$.groups[1]', code: 'group-outside-first-scope' }
    },
    {
        bound: 'a third group in another application than the first',
        change: { groups: [...toRooms(2), { ...GROUP, applicationId: 'other-app' }] },
        issue: { path: '$.groups[2]', code: 'group-outside-first-scope' }
    },
    {
        // The second group is in another application than the first, and the first is the wrong value: it names none.
        bound: 'a first group with no application id, which the second is then not held to',
        change: { groups: [{ ...GROUP, applicationId: '' }, { ...GROUP, groupId: 'workload-room-2' }] },
        issue: { path: '$.groups[0].applicationId', code: 'required' }
    },
    {
        bound: 'six rooms of ten, which are 60 agents',
        change: { groups: toRooms(6), participantCount: 10 },
        issue: { path: '$.groups', code: 'agent-count-above-limit' }
    },
    {
        // Two rooms of 51 are 102 agents, and the agents of a room are the wrong value: a room has at most 50.
        bound: 'two rooms of 51 agents, which the rooms are then not held to',
        change: { groups: toRooms(2), participantCount: 51 },
        issue: { path: '$.participantCount', code: 'invalid-participant-count' }
    },
    {
        // The 500 ms interval is under this cadence, and the cadence is the wrong value: the policy allows 60,000.
        bound: 'a cadence above the policy limit, which the interval is then not held to',
        change: { publication: { ...POINT.publication, cadenceMs: 70_000 } },
        issue: { path: '$.publication.cadenceMs', code: 'invalid-cadence-ms' }
    },
    {
        // The 256-byte payload is above this budget, and the budget is the wrong value: the policy needs 1 byte.
        bound: 'a zero drain.bytes, which the payload is then not held to',
        change: { publication: { ...POINT.publication, drain: { messages: 8, bytes: 0 } } },
        issue: { path: '$.publication.drain.bytes', code: 'invalid-drain-bytes' }
    },
    {
        // 5,000,000 / 500 = 10,000 frames. {"seq":10000,"sentAtEpochMs":1802088000000,"pad":""} is 52 bytes and
        // {"seq":1,"sentAtEpochMs":1802088000000,"pad":""} is 48: 50 bytes hold a frame count within the limit.
        bound: '10,000 frames, which the payload is then not sized for',
        change: { windowMs: 5_000_000, payloadBytes: 50 },
        issue: { path: '$.windowMs', code: 'frame-count-above-limit' }
    },
    {
        bound: 'a loss of neither kind',
        change: { loss: { kind: UNKNOWN_LOSS_KIND } as PublicationWorkloadParameters['loss'] },
        issue: { path: '$.loss', code: 'invalid-loss' }
    },
    {
        // At 1 no frame leaves a publisher: that is a hold, though the platform's seeded loss accepts it.
        bound: 'a loss of every frame',
        change: { loss: { ...QUARTER_LOSS, ratio: 1 } },
        issue: { path: '$.loss.ratio', code: 'loss-ratio-not-below-one' }
    },
    {
        // 3,000 / 500 = 6 frames, all six of them at 0.99; seed 11 drops none of its first six draws.
        bound: 'a loss that drops none of the frames the publisher must hand on',
        change: { windowMs: 3_000, loss: LATE_FIRST_DROP_LOSS },
        issue: { path: '$.loss', code: 'loss-drops-no-frame' }
    },
    {
        // 500 / 500 = 1 frame, and seed 7 drops its first draw: on ws no subscriber has a frame to expect.
        bound: 'a loss on ws that drops every frame',
        change: { carrier: 'ws', windowMs: 500, loss: QUARTER_LOSS },
        issue: { path: '$.loss', code: 'loss-leaves-no-frame' }
    },
    {
        // 3,250 / 500 is 6.5 frames, so the loss is not held to a frame count: as 6 frames it would drop none.
        bound: 'a window that is no multiple of the interval, which the loss is then not held to',
        change: { windowMs: 3_250, loss: LATE_FIRST_DROP_LOSS },
        issue: { path: '$.windowMs', code: 'window-not-multiple-of-publish-interval' }
    }
];

function toPathsAndCodes(parameters: PublicationWorkloadParameters): readonly BrokenBound['issue'][] {
    return validatePublicationWorkloadParameters(parameters).map(({ path, code }) => ({ path, code }));
}

describe('publication workload parameters', () => {
    it('returns no issue for a complete point: 15 agents, one send every 500 ms for 5 minutes on rtc', () => {
        expect(validatePublicationWorkloadParameters(POINT)).toEqual([]);
    });

    it('returns every issue of a point that breaks several bounds, not only the first', () => {
        const issues = validatePublicationWorkloadParameters({
            ...POINT,
            participantCount: 1,
            publishIntervalMs: 50,
            windowMs: 300_025,
            payloadBytes: 10,
            minReceiveRatio: 1.5
        });

        expect(issues.map((issue) => issue.path).sort()).toEqual([
            '$.minReceiveRatio',
            '$.participantCount',
            '$.payloadBytes',
            '$.publishIntervalMs',
            '$.windowMs'
        ]);
    });

    it.each(BROKEN_BOUNDS)('returns the one issue of $bound', ({ change, issue }) => {
        expect(toPathsAndCodes({ ...POINT, ...change })).toEqual([issue]);
    });

    it('returns every issue of every group, each under the group\'s place, and holds a group with one to no rule among the groups', () => {
        const groups = [
            { ...GROUP, groupId: '' },
            // Another application than the first group's, and no valid one.
            { applicationId: '', workspaceId: '', groupId: 'workload-room-2' },
            { ...GROUP, groupId: '' }
        ];

        expect(toPathsAndCodes({ ...POINT, groups })).toEqual([
            { path: '$.groups[0].groupId', code: 'required' },
            { path: '$.groups[1].applicationId', code: 'required' },
            { path: '$.groups[1].workspaceId', code: 'required' },
            { path: '$.groups[2].groupId', code: 'required' }
        ]);
    });

    it('holds a later group to the first group\'s application and workspace when the first group breaks only its group id', () => {
        const groups = [{ ...GROUP, groupId: '' }, { ...GROUP, applicationId: 'other-app', groupId: 'workload-room-2' }];

        expect(toPathsAndCodes({ ...POINT, groups })).toEqual([
            { path: '$.groups[0].groupId', code: 'required' },
            { path: '$.groups[1]', code: 'group-outside-first-scope' }
        ]);
    });

    it('returns no issue at the last valid value of each bound', () => {
        const atBounds: PublicationWorkloadParameters = {
            ...POINT,
            participantCount: 2,
            publishIntervalMs: 100,
            windowMs: 200_000,
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 51 } },
            payloadBytes: 51,
            ttlMs: 1,
            minReceiveRatio: 1,
            minSendSuccessRatio: 1,
            readyTimeoutMs: 1
        };

        expect(validatePublicationWorkloadParameters(atBounds)).toEqual([]);
        expect(
            validatePublicationWorkloadParameters({
                ...POINT,
                participantCount: 50,
                publisherCount: 49,
                payloadBytes: 65_536
            })
        ).toEqual([]);
        // Five rooms of ten are the 50 agents a point may have.
        expect(validatePublicationWorkloadParameters({ ...POINT, groups: toRooms(5), participantCount: 10 }))
            .toEqual([]);
    });

    it('derives 600 frames, 2 Hz, 14 subscribers, at least 570 inbound messages each and 8,400 fan-out messages', () => {
        // 300,000 / 500 = 600 frames, each an expected admission; 1,000 / 500 = 2 Hz; 15 - 1 = 14 subscribers; 570 of
        // 600 is 0.95 and 594 of 600 is 0.99; 600 x 14 = 8,400 fan-out messages.
        expect(computePublicationWorkloadPlan(POINT)).toEqual({
            frameCount: 600,
            configuredRateHz: 2,
            roomCount: 1,
            agentCount: 15,
            subscriberCount: 14,
            expectedAdmissions: 600,
            expectedLostFrames: 0,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570,
            minAcceptedSends: 594,
            logicalFanoutMessages: 8_400
        });
    });

    it('derives for 5 publishers among 15 agents: 10 subscribers, 3,000 inbound messages each, at least 2,700 at 0.9, and 42,000 fan-out messages', () => {
        // 15 - 5 = 10 subscribers. One publisher's 600 frames are its 600 expected admissions, 594 of them at 0.99.
        // A subscriber hears all five publishers: 600 x 5 = 3,000 messages, 2,700 of them at 0.9. Every publisher's
        // frames go to the 14 other members of the room: 600 x 5 x 14 = 42,000 fan-out messages.
        expect(computePublicationWorkloadPlan({ ...POINT, publisherCount: 5, minReceiveRatio: 0.9 })).toEqual({
            frameCount: 600,
            configuredRateHz: 2,
            roomCount: 1,
            agentCount: 15,
            subscriberCount: 10,
            expectedAdmissions: 600,
            expectedLostFrames: 0,
            expectedInboundMessages: 3_000,
            minExpectedInboundMessages: 2_700,
            minAcceptedSends: 594,
            logicalFanoutMessages: 42_000
        });
    });

    it('derives the stretch rung: five rooms of ten with one publisher each are 50 agents and 27,000 fan-out messages over 600 frames', () => {
        const groups = toRooms(5);

        // 5 x 10 = 50 agents; 10 - 1 = 9 subscribers in a room, each hearing its one publisher's 600 frames; in each
        // of the 5 rooms the publisher's frames go to the 9 other members: 600 x 9 x 5 = 27,000, which over the 300 s
        // window is 90 a second.
        expect(computePublicationWorkloadPlan({ ...POINT, groups, participantCount: 10 })).toEqual({
            frameCount: 600,
            configuredRateHz: 2,
            roomCount: 5,
            agentCount: 50,
            subscriberCount: 9,
            expectedAdmissions: 600,
            expectedLostFrames: 0,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570,
            minAcceptedSends: 594,
            logicalFanoutMessages: 27_000
        });
    });

    it('expects 42 of a publisher\'s 60 frames on ws under a quarter loss from seed 7: 18 lost, at least 40 at 0.95, and a fan-out of 84', () => {
        // Seed 7 at 0.25 drops sequence numbers 1, 2, 8, 12, 15, 21, 23, 24, 25, 29, 38, 39, 42, 43, 53, 54, 57 and 60:
        // eighteen, which two browser runs read from both subscribers' logs and whose first five the conformance lane's
        // unretried-loss cell pins. 60 - 18 = 42 frames reach each subscriber; 40 of 42 is 0.952; 57 of 60 is 0.95 for
        // the stage, which hands on every frame the loss later drops; 42 x 2 other members = 84 fan-out messages.
        expect(computePublicationWorkloadPlan(WS_LOSS_POINT)).toEqual({
            frameCount: 60,
            configuredRateHz: 2,
            roomCount: 1,
            agentCount: 3,
            subscriberCount: 2,
            expectedAdmissions: 60,
            expectedLostFrames: 18,
            expectedInboundMessages: 42,
            minExpectedInboundMessages: 40,
            minAcceptedSends: 57,
            logicalFanoutMessages: 84
        });
        expect(validatePublicationWorkloadParameters(WS_LOSS_POINT)).toEqual([]);
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'expects every frame on %s under the same loss: a refused frame is sent again',
        (carrier) => {
            expect(computePublicationWorkloadPlan({ ...WS_LOSS_POINT, carrier })).toMatchObject({
                expectedLostFrames: 0,
                expectedInboundMessages: 60,
                minExpectedInboundMessages: 57
            });
        }
    );

    it('expects (30 - 10) x 2 = 40 from two publishers on ws: each page draws from the same seed', () => {
        // 15,000 / 500 = 30 frames a publisher; seed 7 drops ten of its first thirty draws, the first ten numbers above.
        expect(computePublicationWorkloadPlan({ ...WS_LOSS_POINT, publisherCount: 2, windowMs: 15_000 }))
            .toMatchObject({ expectedLostFrames: 10, expectedInboundMessages: 40, logicalFanoutMessages: 80 });
    });

    it.each([
        { ratio: 0.25, seed: 7, frameCount: 60 },
        { ratio: 0.1, seed: 7, frameCount: 30 },
        { ratio: 0.5, seed: 11, frameCount: 13 },
        { ratio: 0.75, seed: 123_456, frameCount: 200 }
    ])(
        'loses exactly the frames the transport fault port drops when it is asked for each frame in order: $ratio from seed $seed over $frameCount frames',
        ({ ratio, seed, frameCount }) => {
            const port = createScriptedTransportFaultPort();
            port.inject({
                faultId: 'oracle',
                carrier: 'ws',
                match: { controlType: undefined, typeId: 'oracle.frame', msgId: undefined },
                action: { loss: { ratio, seed } },
                remaining: 'until-cleared'
            });
            const frame = JSON.stringify({ id: { msgId: 'm' }, payload: { typeId: 'oracle.frame' } });
            const dropped = Array.from({ length: frameCount }, () => port.decideSend('ws', frame))
                .filter((decision) => decision.kind === 'drop').length;

            const plan = computePublicationWorkloadPlan({
                ...WS_LOSS_POINT,
                windowMs: frameCount * 500,
                loss: { kind: 'seeded', ratio, seed }
            });
            expect(plan.expectedLostFrames).toBe(dropped);
        }
    );

    it.each([
        { loss: { ...QUARTER_LOSS, ratio: 0 }, sentence: 'loss.ratio must be above 0 and at most 1' },
        { loss: { ...QUARTER_LOSS, ratio: 1.5 }, sentence: 'loss.ratio must be above 0 and at most 1' },
        { loss: { ...QUARTER_LOSS, ratio: Number.NaN }, sentence: 'loss.ratio must be above 0 and at most 1' },
        { loss: { ...QUARTER_LOSS, seed: 1.5 }, sentence: 'loss.seed must be an integer' }
    ])('refuses a seeded loss the platform cannot inject at the loss, in the platform\'s own words: $sentence', ({ loss, sentence }) => {
        expect(validatePublicationWorkloadParameters({ ...POINT, loss })).toEqual([{
            path: '$.loss',
            code: 'invalid-seeded-loss',
            message: expect.stringContaining(sentence)
        }]);
    });

    it.each([
        // 57 of 60 is 0.95, under the ratio; 58 of 60 is 0.9667.
        { frameCount: 60, ratio: 0.96, minimum: 58 },
        // 57 of 100 is the ratio itself; 56 of 100 is 0.56.
        { frameCount: 100, ratio: 0.57, minimum: 57 },
        { frameCount: 60, ratio: 0.95, minimum: 57 },
        { frameCount: 600, ratio: 0.95, minimum: 570 },
        { frameCount: 600, ratio: 0.99, minimum: 594 },
        // 0 of 1 is under every valid ratio.
        { frameCount: 1, ratio: 0.95, minimum: 1 }
    ])('needs $minimum of $frameCount frames to reach a ratio of $ratio', ({ frameCount, ratio, minimum }) => {
        const plan = computePublicationWorkloadPlan({
            ...POINT,
            windowMs: frameCount * 500,
            minReceiveRatio: ratio,
            minSendSuccessRatio: ratio
        });

        expect(plan.minExpectedInboundMessages).toBe(minimum);
        expect(plan.minAcceptedSends).toBe(minimum);
    });

    it('serialises to the declared byte size at the widest sequence number and at most three bytes less at sequence 1', () => {
        // 1,000,000 / 500 = 2,000 frames, the family's most: sequence 2000 is three digits wider than sequence 1.
        const payload = toPublicationWorkloadPayload({ ...POINT, windowMs: 1_000_000, payloadBytes: 256 });
        const measureSentBytes = (sequence: number): number =>
            new TextEncoder().encode(JSON.stringify({ ...payload, seq: sequence, sentAtEpochMs: 1_802_088_000_000 }))
                .byteLength;

        expect(payload.seq).toBe('{loop.iteration}');
        expect(payload[PUBLICATION_WORKLOAD_SENT_AT_FIELD]).toBe('{loop.atEpochMs}');
        expect(Object.keys(payload).sort()).toEqual(['pad', 'sentAtEpochMs', 'seq']);
        expect(measureSentBytes(2_000)).toBe(256);
        expect(measureSentBytes(1)).toBe(253);
    });
});
