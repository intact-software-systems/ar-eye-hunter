import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import assert from 'node:assert/strict';

import { toApiMutationRouteFailure } from '../../src/routes/api-mutation-route-failure.ts';

Deno.test('current AppInbox failures retain JSON-safe details in API responses', () => {
    const failure: AppInboxFailure = {
        type: 'app-inbox-failure',
        code: 'payment-denied',
        status: 403,
        message: 'Payment denied',
        issues: [{
            code: 'payment-denied',
            path: ['payment', 0],
            message: 'Payment denied',
            details: { amount: 1, currency: 'NOK' }
        }],
        denial: {
            code: 'payment-denied',
            message: 'Payment denied',
            details: { paymentId: 'payment-1' }
        },
        retry: null
    };

    const rendered = toApiMutationRouteFailure(failure).failure;

    assert.deepEqual(rendered.issues?.[0]?.details, {
        amount: 1,
        currency: 'NOK'
    });
    assert.deepEqual(rendered.denial?.details, { paymentId: 'payment-1' });
    assert.doesNotThrow(() => JSON.stringify(rendered));
});
