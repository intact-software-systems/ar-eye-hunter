import { describe, expect, it } from 'vitest';
import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';

describe('API mutation failure contract', () => {
  it('decodes the complete canonical API mutation failure without changing its values', () => {
    const failure = {
      type: 'api-mutation-failure',
      version: 'canonical.v1',
      code: 'mutation-rate-limited',
      status: 429,
      message: 'Retry after 250 milliseconds',
      issues: [
        {
          code: 'request-invalid',
          path: ['request', 'value', 0],
          message: 'Value is invalid',
          details: { expected: 'safe' },
        },
      ],
      denial: {
        code: 'policy-denied',
        message: 'Policy denied this mutation',
        details: { policy: 'room-write' },
      },
      retry: {
        kind: 'rate-limited',
        retryAfterMs: 250,
        attempts: 2,
        lane: 'room-write',
        queueAgeMs: 40,
        dueAgeMs: 0,
      },
    } as const;

    expect(decodeApiMutationFailure(failure)).toEqual(failure);
  });

  it.each([
    ['NaN detail', { diagnostic: Number.NaN }],
    ['nested non-finite detail', { diagnostics: { elapsedMs: Number.POSITIVE_INFINITY } }],
    ['non-finite detail nested in an array', { diagnostics: [{ attempt: Number.NaN }] }],
  ])('rejects details that are not recursively JSON-wire values: %s', (_description, details) => {
    const failure = {
      ...canonicalUnavailableFailure(),
      issues: [
        {
          code: 'request-invalid',
          path: null,
          message: 'Value is invalid',
          details,
        },
      ],
    };

    expect(decodeApiMutationFailure(failure)).toBeUndefined();
  });

  it.each([
    {
      ...canonicalUnavailableFailure(),
      status: 399,
    },
    {
      ...canonicalUnavailableFailure(),
      unexpected: true,
    },
    {
      ...canonicalUnavailableFailure(),
      retry: {
        ...canonicalUnavailableFailure().retry,
        queueAgeMs: -1,
      },
    },
    {
      ...canonicalUnavailableFailure(),
      retry: {
        ...canonicalUnavailableFailure().retry,
        attempts: -1,
      },
    },
    {
      ...canonicalUnavailableFailure(),
      retry: {
        ...canonicalUnavailableFailure().retry,
        kind: 'rate-limited',
        retryAfterMs: null,
      },
    },
    {
      ...canonicalUnavailableFailure(),
      retry: {
        ...canonicalUnavailableFailure().retry,
        kind: 'exhausted',
      },
      status: 429,
    },
  ])('rejects incomplete, malformed, or inconsistent mutation failures', (failure) => {
    expect(decodeApiMutationFailure(failure)).toBeUndefined();
  });
});

function canonicalUnavailableFailure() {
  return {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: 'app-inbox-unavailable',
    status: 503,
    message: 'App inbox entry did not complete within the wait budget',
    issues: null,
    denial: null,
    retry: {
      kind: 'unavailable',
      retryAfterMs: null,
      attempts: null,
      lane: null,
      queueAgeMs: null,
      dueAgeMs: null,
    },
  };
}
