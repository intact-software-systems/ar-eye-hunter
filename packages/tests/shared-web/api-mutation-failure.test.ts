import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

describe('API mutation failure HTTP decoding', () => {
  it('exposes an exact canonical mutation failure from an HTTP error response', () => {
    const bodyText = JSON.stringify({
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
    });

    const error = new ApiHttpError('POST', '/api/mutations/widgets', 503, bodyText);

    expect(error.mutationFailure).toEqual(JSON.parse(bodyText));
  });
});
