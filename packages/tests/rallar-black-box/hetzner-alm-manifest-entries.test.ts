import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toAlmConformanceCombinedRecipe } from '../../../apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';

/** No generated scenario carries a request of its own today, so the fixture places one right after the connect. */
function withInScenarioRequest(scenario: AlmConformanceScenario): AlmConformanceScenario {
    const commands = scenario.sender.commands;
    const connectAt = commands.findIndex((command) => command.kind === 'rtc.connect');
    const request: RallarBlackBoxTestCommand = {
        kind: 'http.request',
        commandId: 'in-scenario-request',
        request: { method: 'GET', path: '/api/state/apps/app/workspaces/ws/groups/room-alm' }
    };
    const sender = { ...scenario.sender, commands: [...commands.slice(0, connectAt + 1), request, ...commands.slice(connectAt + 1)] };
    return { ...scenario, sender };
}

describe('ALM conformance combined recipe', () => {
    it('shares one prologue and keeps a request that is a step inside a scenario', () => {
        const [baseline, expires] = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier: 'rtc',
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).filter((scenario) => ['delivery-baseline', 'not-yet-in-sync-expires'].includes(scenario.scenarioKey));

        const requests = toAlmConformanceCombinedRecipe([baseline!, withInScenarioRequest(expires!)], 'sender', 'two-agent').commands
            .filter((command) => command.kind === 'http.request')
            .map((command) => command.commandId);

        expect(requests).toEqual([
            'alm-rtc-delivery-baseline-sender-ensure-group',
            'alm-rtc-delivery-baseline-sender-ensure-member',
            'in-scenario-request'
        ]);
    });
});
