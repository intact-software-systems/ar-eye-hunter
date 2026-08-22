import { assertApiMutationRequestId, isApiMutationRequestId, toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { describe, expect, it } from 'vitest';

const MINIMUM_REQUEST_ID = 'a'.repeat(20);
const MAXIMUM_REQUEST_ID = 'Z'.repeat(128);

describe('API mutation request identity', () => {
    it('accepts boundary-length case-sensitive request IDs and constructs request paths', () => {
        expect(isApiMutationRequestId(MINIMUM_REQUEST_ID)).toBe(true);
        expect(isApiMutationRequestId(MAXIMUM_REQUEST_ID)).toBe(true);
        expect(assertApiMutationRequestId('Aa_9-Zz_123456789012')).toBe('Aa_9-Zz_123456789012');
        expect(toApiMutationRequestPath('/api/mutations/widgets', MINIMUM_REQUEST_ID)).toBe(
            `/api/mutations/widgets/requests/${MINIMUM_REQUEST_ID}`
        );
    });

    it.each([
        'a'.repeat(19),
        'a'.repeat(129),
        'a'.repeat(19) + ' ',
        'a'.repeat(19) + '/',
        'a'.repeat(19) + '.',
        'a'.repeat(19) + 'å'
    ])('rejects request IDs outside the public character and length contract: %j', (requestId) => {
        expect(isApiMutationRequestId(requestId)).toBe(false);
        expect(() => assertApiMutationRequestId(requestId)).toThrow('API mutation requestId');
    });
});
