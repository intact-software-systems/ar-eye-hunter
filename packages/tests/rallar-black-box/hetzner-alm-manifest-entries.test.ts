import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    createAlmConformance2AgentEntry,
    createAlmConformance3AgentEntry,
    toAlmConformanceCombinedRecipe
} from '../../../apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';

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

    it('lists every scenario type of every carrier on each combined connect, since RTC subscribes per type', () => {
        const carriers = ['ws', 'rtc', 'rtc-with-ws-fallback'];
        const families = [
            { entry: createAlmConformance2AgentEntry(), scenarioKeys: ['delivery-baseline', 'delivery-reload'] },
            {
                entry: createAlmConformance3AgentEntry(),
                scenarioKeys: ['aggregated-receipt', 'frozen-audience-membership']
            }
        ];
        for (const { entry, scenarioKeys } of families) {
            for (const selection of entry.manifest.recipes) {
                const recipe = selection.recipe as RallarBlackBoxTestRecipe;
                const connects = recipe.commands.filter((command) => command.kind === 'rtc.connect');
                expect(connects.length).toBeGreaterThan(0);
                // A replayed send names no type of its own; it re-admits an earlier handle's envelope.
                const carriedTypeIds = recipe.commands.flatMap((command) =>
                    (command.kind === 'messages.send' || command.kind === 'messages.received') && 'typeId' in command
                        ? [command.typeId]
                        : []
                );
                for (const connect of connects) {
                    const listed = connect.rallar?.messageTypeIds as readonly string[] | undefined;
                    expect(listed).toBeDefined();
                    expect(listed).toEqual([...new Set(listed)].sort());
                    expect(listed).toEqual(expect.arrayContaining([...carriedTypeIds, connect.rallar?.typeId]));
                    for (const carrier of carriers) {
                        for (const scenarioKey of scenarioKeys) {
                            expect(listed).toContain(`alm.conformance.${carrier}.${scenarioKey}`);
                        }
                    }
                    // A protocol control type is owned by the ALM runtime's own RTC callback, never by the harness.
                    expect(listed?.some((typeId) => typeId.startsWith('al.control.'))).toBe(false);
                    expect(connect.rallar?.messageSelector).toEqual({ topicId: 'room.alm-conformance' });
                }
            }
        }
    });
});
