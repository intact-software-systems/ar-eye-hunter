import { describe, expect, it } from 'vitest';

import { toOwnedAppInboxResourceIds } from './postgres-app-inbox-attempt-evidence.ts';
import { findSingleRetriedAppInboxAttemptSequence } from './fixtures/postgres-app-inbox-worker-runtime.ts';

describe('Postgres AppInbox worker attempt evidence', () => {
  it('selects the retry sequence from the two owned commands only', () => {
    const attempts = findSingleRetriedAppInboxAttemptSequence({
      traces: [
        {
          attempts: [
            attempt('retained-command', 1, 'retryable', 1),
            attempt('owned-command-right', 1, 'accepted', 0),
          ],
        },
        {
          attempts: [
            attempt('owned-command-left', 2, 'accepted', 0),
            attempt('retained-command', 2, 'accepted', 0),
            attempt('owned-command-left', 1, 'retryable', 1),
          ],
        },
      ],
      ownedResourceIds: ['owned-command-left', 'owned-command-right'],
    });

    expect(attempts).toEqual([
      attempt('owned-command-left', 1, 'retryable', 1),
      attempt('owned-command-left', 2, 'accepted', 0),
    ]);
  });

  it('selects an overlength request through its canonical queue resource ID', () => {
    const requestId = `topology-worker-${'overlength'.repeat(4)}`;
    const [resourceId] = toOwnedAppInboxResourceIds([requestId]);

    expect(requestId.length).toBeGreaterThan(36);
    expect(resourceId).toHaveLength(36);
    expect(
      findSingleRetriedAppInboxAttemptSequence({
        traces: [
          {
            attempts: [
              attempt(resourceId!, 2, 'accepted', 0),
              attempt(resourceId!, 1, 'retryable', 1),
            ],
          },
        ],
        ownedResourceIds: [resourceId!],
      }),
    ).toEqual([attempt(resourceId!, 1, 'retryable', 1), attempt(resourceId!, 2, 'accepted', 0)]);
  });
});

function attempt(
  resourceId: string,
  attemptNumber: number,
  classification: 'accepted' | 'retryable',
  retryDelayMs: number,
) {
  return {
    resourceId,
    attempt: attemptNumber,
    classification,
    retryDelayMs,
  } as const;
}
