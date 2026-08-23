import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

describe('API mutation failure HTTP decoding', () => {
    it('exposes an exact canonical mutation failure from an HTTP error response', () => {
        const bodyText = JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
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
                dueAgeMs: null
            }
        });

        const error = new ApiHttpError('POST', '/api/mutations/widgets', 503, bodyText);

        expect(error.mutationFailure).toEqual(JSON.parse(bodyText));
    });

    it('preserves Retry-After alongside the exact canonical rate-limit failure', () => {
        const bodyText = JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: 'rate-limited',
            status: 429,
            message: 'Too many mutation requests',
            issues: null,
            denial: null,
            retry: {
                kind: 'rate-limited',
                retryAfterMs: 12_500,
                attempts: null,
                lane: null,
                queueAgeMs: null,
                dueAgeMs: null
            }
        });
        const headers = new Headers({ 'Retry-After': '13' });

        const error = new ApiHttpError('POST', '/api/mutations/widgets', 429, bodyText, headers);

        expect(error.mutationFailure).toEqual(JSON.parse(bodyText));
        expect(error.headers?.get('Retry-After')).toBe('13');
    });
});
