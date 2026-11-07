import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

// A gate that names a step its role's recipe lacks would hold the continuation back until the lane's gate timeout.
vi.mock(
    '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-ordered-reconnect.ts',
    async (importOriginal) => {
        const original = await importOriginal<
            typeof import('@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-ordered-reconnect.ts')
        >();
        const continuation = original.subscriptionOrderedReconnect.continuation!;
        return {
            ...original,
            subscriptionOrderedReconnect: {
                ...original.subscriptionOrderedReconnect,
                continuation: { ...continuation, gate: { role: 'receiver', commandName: 'assert-never-run' } }
            }
        };
    }
);

describe('a scenario gate', () => {
    it('fails recipe creation, naming the command its role\'s recipe lacks', () => {
        expect(() => createAlmConformanceRecipes(toConformanceInput('ws'))).toThrow(
            'alm-ws-subscription-ordered-reconnect-receiver names no ' +
                'alm-ws-subscription-ordered-reconnect-receiver-assert-never-run command for its gate.'
        );
    });
});
