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
    '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-reconnect.ts',
    async (importOriginal) => {
        const original = await importOriginal<
            typeof import('@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/subscription-reconnect.ts')
        >();
        const continuation = original.subscriptionReconnect.continuation!;
        return {
            ...original,
            subscriptionReconnect: {
                ...original.subscriptionReconnect,
                continuation: { ...continuation, gate: { role: 'sibling', commandName: 'assert-never-run' } }
            }
        };
    }
);

describe('a scenario gate', () => {
    it('fails recipe creation, naming the command its role\'s recipe lacks', () => {
        expect(() => createAlmConformanceRecipes(toConformanceInput('ws'))).toThrow(
            'alm-ws-subscription-reconnect-sibling names no alm-ws-subscription-reconnect-sibling-assert-never-run command ' +
                'for its gate.'
        );
    });
});
