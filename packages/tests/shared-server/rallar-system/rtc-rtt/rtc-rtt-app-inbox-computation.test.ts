import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import {
    computeRtcRttAppInboxMutation,
    validateRtcRttAppInboxMutation
} from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-computation.ts';
import { describe, expect, it } from 'vitest';
import { createAtomicHarness } from '../app-inbox/test-support/app-inbox-transaction-test-runtime.ts';

const COMMAND_HASH = `sha256:${'a'.repeat(64)}`;

describe('RTC RTT AppInbox computation', () => {
    it('computes and validates the complete durable mutation before writing', () => {
        const harness = createAtomicHarness();
        const incoming = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const input = {
            command: {
                rtt: incoming,
                alSenderId: 'session-a',
                candidateGroups: [],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            },
            read: {
                receipt: null,
                expiredMeasurementEntry: null,
                measurement: {
                    entry: {
                        key: 'pair=session-a%3A%3Asession-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4
                    },
                    value: { ...incoming, version: 3 }
                },
                endpointAdmissions: [],
                expiredEndpointAdmissionEntries: [],
                measurements: []
            },
            facts: {
                purgeAfterEpochMs: 10_000,
                requestedAtEpochMs: 2,
                commandHash: COMMAND_HASH,
                attemptCount: 1
            },
            requestId: 'request-1',
            completionFacts: new AppInboxTransactionWriter(
                { database: harness.database.sql },
                { serviceId: 'server-1', nowEpochMs: () => 2 }
            ).readCompletionFacts(harness.context)
        } as const;

        const computed = computeRtcRttAppInboxMutation(input);

        expect(computeRtcRttAppInboxMutation(input)).toEqual(computed);
        expect(computed.mutation).toMatchObject({ outcome: 'rejected', reason: 'stale' });
        expect(computed.durableResult).toEqual({
            requestId: 'request-1',
            accepted: true,
            reason: 'accepted',
            affectedGroups: [],
            updated: false
        });
        expect(() => validateRtcRttAppInboxMutation(input, computed)).not.toThrow();
        expect(() =>
            validateRtcRttAppInboxMutation(input, {
                ...computed,
                durableResult: { ...computed.durableResult, updated: true }
            })
        ).toThrow('computed.durableResult.updated differs from the computed value');
    });
});
