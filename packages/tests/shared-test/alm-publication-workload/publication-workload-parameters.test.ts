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

/** 15 agents, one send every 500 ms for 5 minutes on rtc: 300,000 / 500 = 600 frames. */
const POINT: PublicationWorkloadParameters = {
    group: { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' },
    participantCount: 15,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 300_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.99,
    readyTimeoutMs: 45_000
};

const UNKNOWN_CARRIER: string = 'sctp';

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
        expect(validatePublicationWorkloadParameters({ ...POINT, participantCount: 50, payloadBytes: 65_536 }))
            .toEqual([]);
    });

    it('derives 600 frames, 2 Hz, 14 subscribers, a floor of 570 and 8,400 fan-out messages', () => {
        // 300,000 / 500 = 600 frames; 1,000 / 500 = 2 Hz; 15 - 1 = 14 subscribers; floor(600 x 0.95) = 570
        // deliveries; floor(600 x 0.99) = 594 accepted sends; 600 x 14 = 8,400 fan-out messages.
        expect(computePublicationWorkloadPlan(POINT)).toEqual({
            frameCount: 600,
            configuredRateHz: 2,
            subscriberCount: 14,
            expectedDeliveriesPerSubscriber: 600,
            minDeliveriesPerSubscriber: 570,
            minAcceptedSends: 594,
            logicalFanoutMessages: 8_400
        });
    });

    it('rounds a ratio that leaves a fraction of a message down: 60 frames at 0.96 need 57, not 58', () => {
        // 30,000 / 500 = 60 frames; 60 x 0.96 = 57.6, and the floor is 57.
        const plan = computePublicationWorkloadPlan({
            ...POINT,
            windowMs: 30_000,
            minReceiveRatio: 0.96,
            minSendSuccessRatio: 0.96
        });

        expect(plan.minDeliveriesPerSubscriber).toBe(57);
        expect(plan.minAcceptedSends).toBe(57);
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
