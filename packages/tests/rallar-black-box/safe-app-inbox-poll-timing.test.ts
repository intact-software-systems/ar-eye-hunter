import { describe, expect, it } from 'vitest';

import { toSafeApiTimingRecord } from '../../../apps/rallar-black-box/scripts/to-safe-api-timing-record.ts';

const poll = {
    type: 'rallar.timing',
    component: 'app-inbox-phase',
    operation: 'wait-poll',
    status: 'ok',
    durationMs: 0,
    atEpochMs: 1234,
    serviceId: 'server-1',
    requestId: 'request-1',
    details: { type: 'GROUP_CREATE', topicId: 'AppInbox', resourceId: 'request-1', contextId: 'context-1', senderId: 'sender-1' }
};

describe('safe AppInbox poll timing projection', () => {
    it.each(['missing', 'NEW', 'RESERVED', 'RETRY', 'COMPLETED', 'FAILED', 'NON_RETRYABLE', 'other-status', 'read-failure'])(
        'retains the closed %s category with existing identities and valid-row attempts',
        (queueObservation) => {
            const attempts = queueObservation === 'missing' || queueObservation === 'read-failure' ? {} : { attempts: 7 };
            expect(toSafeApiTimingRecord(JSON.stringify({ ...poll, details: { ...poll.details, ...attempts, queueObservation } }))).toEqual({
                ...poll,
                details: { ...poll.details, ...attempts, queueObservation }
            });
        }
    );

    it.each(['arbitrary-secret', 'ABORTED', 1, null, { secret: 'private' }])('drops non-allowlisted observation %j', (queueObservation) => {
        expect(toSafeApiTimingRecord(JSON.stringify({ ...poll, details: { ...poll.details, queueObservation } }))).toEqual(poll);
    });

    it('excludes payloads, credentials, errors and additional timestamps from sampled observations', () => {
        expect(toSafeApiTimingRecord(JSON.stringify({
            ...poll,
            authorization: 'SECRET',
            error: { message: 'SECRET' },
            ri_resource: 'SECRET',
            details: {
                ...poll.details,
                queueObservation: 'RESERVED',
                attempts: 3,
                ri_resource: 'SECRET',
                authorization: 'SECRET',
                errorName: 'SECRET',
                errorMessage: 'SECRET',
                startTs: 44,
                endTs: 55,
                nextTs: 66,
                observedAtEpochMs: 77
            }
        }))).toEqual({ ...poll, details: { ...poll.details, queueObservation: 'RESERVED', attempts: 3 } });
    });
});
