import {
    describe,
    expect,
    it
} from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';

import { toAlmConformanceCombinedRecipe } from '../../../apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';

describe('ALM conformance combined recipe', () => {
    it('shares one prologue and keeps a request that is a step inside a scenario', () => {
        const scenarios = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier: 'rtc',
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).filter((scenario) => ['delivery-baseline', 'not-yet-in-sync-delivered-after-refresh'].includes(scenario.scenarioKey));

        const requests = toAlmConformanceCombinedRecipe(scenarios, 'sender').commands
            .filter((command) => command.kind === 'http.request')
            .map((command) => command.commandId);

        expect(requests).toEqual([
            'alm-rtc-delivery-baseline-sender-ensure-group',
            'alm-rtc-delivery-baseline-sender-ensure-member',
            'alm-rtc-not-yet-in-sync-delivered-after-refresh-sender-advance-group'
        ]);
    });
});
