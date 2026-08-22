import { Reservator } from '@shared/queuebox/DequeueController.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { deriveAppInboxAttemptObservations } from '../../../scripts/perf/api-v1-state-write-attempt-evidence.ts';

const evidence = [{
    commandId: 'command-1',
    operationId: 'operation-1',
    resourceId: 'resource-1',
    topicId: 'topic-1',
    contextId: 'scope'
}];

function release(
    failure: Readonly<{
        kind: 'retryable';
        code: string;
        name: string;
    }>
) {
    return {
        key: { topicId: 'topic-1', resourceId: 'resource-1', contextId: 'scope' },
        type: 'APP_INBOX',
        resource: '{}',
        attempt: 1,
        selectedLane: Reservator.NEW,
        queueAgeMs: 1,
        dueAgeMs: 0,
        classification: 'retryable' as const,
        status: EntityStatus.RETRY,
        retryDelayMs: 2,
        failure
    };
}

describe('state-write attempt evidence', () => {
    it('does not classify a generic retryable infrastructure failure as a conflict', () => {
        const observations = deriveAppInboxAttemptObservations(
            [
                release({ kind: 'retryable', code: 'ECONNRESET', name: 'Error' })
            ],
            evidence,
            [{ commandId: 'command-1', status: 'accepted' }]
        );

        expect(observations).toEqual([expect.objectContaining({
            outcome: 'transient-retry',
            failure: { kind: 'retryable', code: 'ECONNRESET', name: 'Error' }
        })]);
    });

    it('classifies a typed optimistic write failure as a conflict', () => {
        const observations = deriveAppInboxAttemptObservations(
            [
                release({
                    kind: 'retryable',
                    code: 'RuntimeStateWriteConflictError',
                    name: 'RuntimeStateWriteConflictError'
                })
            ],
            evidence,
            [{ commandId: 'command-1', status: 'accepted' }]
        );

        expect(observations).toEqual([expect.objectContaining({
            outcome: 'conflicted',
            failure: expect.objectContaining({ name: 'RuntimeStateWriteConflictError' })
        })]);
    });

    it('does not attribute a release from another physical AppInbox context', () => {
        const wrongContext = {
            ...release({ kind: 'retryable', code: 'ECONNRESET', name: 'Error' }),
            key: { topicId: 'topic-1', resourceId: 'resource-1', contextId: 'other-scope' }
        };

        expect(deriveAppInboxAttemptObservations(
            [wrongContext],
            evidence,
            [{ commandId: 'command-1', status: 'accepted' }]
        )).toEqual([]);
    });
});
