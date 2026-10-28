import { Temporal } from '@js-temporal/polyfill';
import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import {
    AppInboxType,
    toAppInboxCommandAttempt,
    type AppInboxExecutionMetadata
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { computeResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

describe('toAppInboxCommandAttempt', () => {
    it('reads the attempt count from the entry and the trace from the stored envelope', () => {
        expect(toAppInboxCommandAttempt(createExecutionMetadata())).toEqual({
            attemptCount: 3,
            traceId: 'trace-app-inbox-command-attempt'
        });
    });
});

function createExecutionMetadata(): AppInboxExecutionMetadata {
    const enqueue = decodeAppInboxEnqueue({
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        topicId: AppInboxType.CLIENT_SESSION_CONNECT,
        resourceId: 'request-app-inbox-command-attempt',
        contextId: 'room-1',
        data: { requestId: 'request-app-inbox-command-attempt' }
    });
    const key = { topicId: AppInboxType.CLIENT_SESSION_CONNECT, resourceId: 'request-app-inbox-command-attempt', contextId: 'room-1' };
    const entry: ResourceEntry = {
        key,
        resource: JSON.stringify(enqueue),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'app-inbox-test-service',
            createdTs: Temporal.PlainDateTime.from('2026-10-28T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-10-28T13:00:00Z')
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 3 }
    };
    return {
        enqueue,
        message: {
            id: {
                v: 4,
                msgId: key.resourceId,
                ts: 1_000,
                senderId: 'app-inbox-test-service',
                traceId: 'trace-app-inbox-command-attempt'
            },
            route: key,
            payload: { typeId: enqueue.type, contentType: 'application/json', resource: entry.resource }
        },
        entry,
        attemptTelemetry: computeResourceInboxAttempt({
            entry,
            selectedLane: Reservator.NEW,
            selectedAtEpochMs: 1_000,
            selectedDueAtEpochMs: undefined,
            reservationLeaseMs: 60_000
        }).telemetry
    };
}
