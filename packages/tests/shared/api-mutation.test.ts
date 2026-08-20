import { describe, expect, it } from 'vitest';
import {
  assertApiMutationRequestId,
  decodeApiMutationFailure,
  isApiMutationRequestId,
  toApiMutationRequestPath,
} from '@shared/api/mutation/api-mutation.ts';

const MINIMUM_REQUEST_ID = 'a'.repeat(20);
const MAXIMUM_REQUEST_ID = 'Z'.repeat(128);

describe('API mutation contract', () => {
  it('accepts boundary-length case-sensitive request IDs and constructs request paths', () => {
    expect(isApiMutationRequestId(MINIMUM_REQUEST_ID)).toBe(true);
    expect(isApiMutationRequestId(MAXIMUM_REQUEST_ID)).toBe(true);
    expect(assertApiMutationRequestId('Aa_9-Zz_123456789012')).toBe('Aa_9-Zz_123456789012');
    expect(toApiMutationRequestPath('/api/mutations/widgets', MINIMUM_REQUEST_ID)).toBe(
      `/api/mutations/widgets/requests/${MINIMUM_REQUEST_ID}`,
    );
  });

  it.each([
    'a'.repeat(19),
    'a'.repeat(129),
    'a'.repeat(19) + ' ',
    'a'.repeat(19) + '/',
    'a'.repeat(19) + '.',
    'a'.repeat(19) + 'å',
  ])('rejects request IDs outside the public character and length contract: %j', (requestId) => {
    expect(isApiMutationRequestId(requestId)).toBe(false);
    expect(() => assertApiMutationRequestId(requestId)).toThrow('API mutation requestId');
  });

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
