import { describe, expect, it } from 'vitest';

import { findSingleRetriedAppInboxAttemptSequence } from '../../../integration/postgres/test-support/postgres-app-inbox-attempt-observation.ts';
import { toOwnedAppInboxResourceIds } from './read-owned-app-inbox-resource-ids.ts';

describe('owned Postgres AppInbox retry attempt selection', () => {
    it('selects the retry sequence from the two owned commands only', () => {
        const attempts = findSingleRetriedAppInboxAttemptSequence({
            traces: [
                {
                    attempts: [
                        attempt({ resourceId: 'retained-command', attempt: 1, classification: 'retryable', retryDelayMs: 1 }),
                        attempt({ resourceId: 'owned-command-right', attempt: 1, classification: 'accepted', retryDelayMs: 0 })
                    ]
                },
                {
                    attempts: [
                        attempt({ resourceId: 'owned-command-left', attempt: 2, classification: 'accepted', retryDelayMs: 0 }),
                        attempt({ resourceId: 'retained-command', attempt: 2, classification: 'accepted', retryDelayMs: 0 }),
                        attempt({ resourceId: 'owned-command-left', attempt: 1, classification: 'retryable', retryDelayMs: 1 })
                    ]
                }
            ],
            ownedResourceIds: ['owned-command-left', 'owned-command-right']
        });

        expect(attempts).toEqual([
            attempt({ resourceId: 'owned-command-left', attempt: 1, classification: 'retryable', retryDelayMs: 1 }),
            attempt({ resourceId: 'owned-command-left', attempt: 2, classification: 'accepted', retryDelayMs: 0 })
        ]);
    });

    it('selects an overlength request through its canonical queue resource ID', () => {
        const requestId = `topology-worker-${'overlength'.repeat(4)}`;
        const resourceId = requireFirst(toOwnedAppInboxResourceIds([requestId]), 'owned AppInbox resource ID');

        expect(requestId.length).toBeGreaterThan(36);
        expect(resourceId).toHaveLength(36);
        expect(
            findSingleRetriedAppInboxAttemptSequence({
                traces: [
                    {
                        attempts: [
                            attempt({ resourceId, attempt: 2, classification: 'accepted', retryDelayMs: 0 }),
                            attempt({ resourceId, attempt: 1, classification: 'retryable', retryDelayMs: 1 })
                        ]
                    }
                ],
                ownedResourceIds: [resourceId]
            })
        ).toEqual([
            attempt({ resourceId, attempt: 1, classification: 'retryable', retryDelayMs: 1 }),
            attempt({ resourceId, attempt: 2, classification: 'accepted', retryDelayMs: 0 })
        ]);
    });
});

interface AttemptInput {
    readonly resourceId: string;
    readonly attempt: number;
    readonly classification: 'accepted' | 'retryable';
    readonly retryDelayMs: number;
}

function attempt(input: AttemptInput) {
    const { resourceId, attempt: attemptNumber, classification, retryDelayMs } = input;
    return {
        resourceId,
        attempt: attemptNumber,
        classification,
        retryDelayMs
    } as const;
}

function requireFirst<Value>(values: readonly Value[], label: string): Value {
    const first = values[0];
    if (first === undefined) {
        throw new Error(`Expected ${label}.`);
    }
    return first;
}
