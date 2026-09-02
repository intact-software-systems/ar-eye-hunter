import { describe, expect, it } from 'vitest';

import {
    computeRtcRttAppInboxMutation,
    validateRtcRttAppInboxMutation,
    type RtcRttAppInboxRead
} from '@shared-server/rallar-system/rtc-rtt/inbox/compute-rtc-rtt-app-inbox-mutation.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('RTC RTT AppInbox completion candidate', () => {
    it('rejects a proxy candidate without invoking its traps', () => {
        const read = rejectedRead();
        const computed = computeRtcRttAppInboxMutation(read);
        let reads = 0;
        const candidate = new Proxy(computed, {
            get(target, key, receiver) {
                reads += 1;
                return Reflect.get(target, key, receiver);
            },
            getOwnPropertyDescriptor(target, key) {
                reads += 1;
                return Reflect.getOwnPropertyDescriptor(target, key);
            }
        });

        expect(validateRtcRttAppInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(reads).toBe(0);
    });

    it('rejects a domain accessor without reading it', () => {
        const read = rejectedRead();
        const computed = computeRtcRttAppInboxMutation(read);
        let reads = 0;
        const mutation = { ...computed.mutation };
        Object.defineProperty(mutation, 'reason', {
            enumerable: true,
            get: () => {
                reads += 1;
                return computed.mutation.reason;
            }
        });

        expect(validateRtcRttAppInboxMutation(read, { ...computed, mutation }).length).toBeGreaterThan(0);
        expect(reads).toBe(0);
    });

    it('computes a rejected durable response and completion from the same read', () => {
        const read = rejectedRead();
        const computed = computeRtcRttAppInboxMutation(read);

        expect(computed.completion.durableResult).toEqual({
            requestId: 'rtt-request',
            accepted: false,
            reason: 'no-shared-active-group',
            affectedGroups: [],
            updated: false
        });
        expect(computed.completion.encodedResult).toEqual(computed.completion.durableResult);
        expect(computed.completion.reservationFinish).toMatchObject({
            expectedAttempts: 2,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(2_000)
        });
        expect(validateRtcRttAppInboxMutation(read, computed)).toEqual([]);
        expect(computeRtcRttAppInboxMutation(read)).toEqual(computed);
    });

    it('rejects a changed domain candidate and completion against original facts', () => {
        const read = rejectedRead();
        const computed = computeRtcRttAppInboxMutation(read);
        if (computed.mutation.outcome !== 'rejected') {
            throw new Error('Expected a rejected RTT candidate');
        }
        const candidate = {
            ...computed,
            mutation: { ...computed.mutation, reason: 'stale' as const },
            completion: {
                ...computed.completion,
                reservationFinish: { ...computed.completion.reservationFinish, expectedAttempts: 3 }
            }
        };

        expect(validateRtcRttAppInboxMutation(read, candidate).map((issue) => issue.path)).toEqual(
            expect.arrayContaining(['computed.mutation.reason', 'computed.completion.reservationFinish.expectedAttempts'])
        );
        expect(candidate.completion.reservationFinish.expectedAttempts).toBe(3);
        expect(
            validateRtcRttAppInboxMutation({
                ...read,
                completionFacts: { ...read.completionFacts, completedAtEpochMs: 3_000 }
            }, computed).length
        ).toBeGreaterThan(0);
    });
});

function rejectedRead(): RtcRttAppInboxRead {
    const entry = toResourceEntry('APP_INBOX', { requestId: 'rtt-request' });
    return {
        requestId: 'rtt-request',
        command: {
            rtt: {
                sessionIdFrom: 'alice-session',
                sessionIdTo: 'bob-session',
                rttMs: 12,
                createdAtEpochMs: 1_000,
                version: 1
            },
            alSenderId: 'alice-session',
            candidateGroups: [],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 2
        },
        mutationRead: {
            receipt: null,
            measurement: null,
            expiredMeasurementEntry: null,
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        },
        facts: {
            commandHash: `sha256:${'a'.repeat(64)}`,
            attemptCount: 2,
            requestedAtEpochMs: 1_000,
            purgeAfterEpochMs: 61_000
        },
        completionFacts: {
            entry: { ...entry, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 2 } },
            completedAtEpochMs: 2_000
        }
    };
}
