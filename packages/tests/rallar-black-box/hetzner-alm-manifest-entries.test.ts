import {
    describe,
    expect,
    it
} from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { AL_VOLATILE_SESSION_MAX_ADMISSIONS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

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
            {
                entry: createAlmConformance2AgentEntry(),
                scenarioKeys: ['delivery-baseline', 'delivery-reload', 'ws-unicast-receipt', 'capacity']
            },
            {
                entry: createAlmConformance3AgentEntry(),
                scenarioKeys: ['aggregated-receipt', 'frozen-audience-membership']
            }
        ];
        for (const { entry, scenarioKeys } of families) {
            for (const selection of entry.manifest.recipes) {
                const recipe = selection.recipe!;
                const connects = recipe.commands.filter((command) => command.kind === 'rtc.connect');
                expect(connects.length).toBeGreaterThan(0);
                // A replayed send names no type of its own; it re-admits an earlier handle's envelope.
                const carriedTypeIds = recipe.commands.flatMap((command) =>
                    (command.kind === 'messages.send' || command.kind === 'messages.received') && 'typeId' in command
                        ? [command.typeId]
                        : []
                );
                for (const connect of connects) {
                    const listed = connect.rallar?.messageTypeIds;
                    if (!Array.isArray(listed)) {
                        throw new Error(`Combined connect ${connect.commandId} must list its subscribed message types.`);
                    }
                    expect(listed).toBeDefined();
                    expect(listed).toEqual([...new Set(listed)].sort());
                    expect(listed).toEqual(expect.arrayContaining([...carriedTypeIds, connect.rallar?.typeId]));
                    for (const carrier of carriers) {
                        for (const scenarioKey of scenarioKeys) {
                            expect(listed).toContain(`alm.conformance.${carrier}.${scenarioKey}`);
                        }
                    }
                    // A protocol control type is owned by the ALM runtime's own RTC callback, never by the harness.
                    expect(listed.some((typeId) => typeof typeId === 'string' && typeId.startsWith('al.control.'))).toBe(false);
                    expect(connect.rallar?.messageSelector).toEqual({ topicId: 'room.alm-conformance' });
                }
            }
        }
    });

    it('keeps the capacity sender\'s lowered volatile limits through the combined connect, then restores them', () => {
        const sender = createAlmConformance2AgentEntry().manifest.recipes
            .find((selection) => selection.role === 'sender')!.recipe!;
        const connects = sender.commands.filter((
            command
        ): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect' && command.commandId?.includes('-capacity-sender-') === true);

        expect(connects.map((command) => [command.commandId, command.rallar?.almVolatileLimits]))
            .toEqual(
                ['ws', 'rtc', 'rtc-with-ws-fallback'].flatMap((carrier) => [
                    [`alm-${carrier}-capacity-sender-connect-lowered`, {
                        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
                        maxBytes: 36_000
                    }],
                    [`alm-${carrier}-capacity-sender-connect-restored`, undefined]
                ])
            );
        expect(connects.every((command) => command.readiness?.minReadyPeers === 1)).toBe(true);
    });
});

/** Every `alm-<carrier>-<scenarioKey>` cell the catalog defines in the named lane families. */
function toFamilyCells(families: readonly AlmConformanceLaneFamily[]): readonly string[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier,
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).filter((scenario) => families.includes(scenario.laneFamily))
            .map((scenario) => `alm-${carrier}-${scenario.scenarioKey}`)
    );
}

function toStartedCells(entry: ReturnType<typeof createAlmConformance2AgentEntry>): readonly string[] {
    const sender = entry.manifest.recipes
        .find((selection) => selection.role === 'sender')!.recipe!;
    return toBarrierIds(sender).filter((id) => id.endsWith('-start')).map((id) => id.replace(/-start$/, ''));
}

describe('ALM conformance hosted lane families', () => {
    it('withholds exactly the named cells: both checkpoint cells, the exhausted repair and the age and track bound cells everywhere, the gap repair, the congestion and the fairness cells where they run', () => {
        const defined = toFamilyCells(['two-agent', 'addressed']);
        // Removing a withheld cell from hosted manifest 18 is a deliberate act: the checkpoint, repair, volatile
        // bound, congestion and fairness cells keep manifest 18 as recorded.
        const withheld = [
            ...ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
                ['checkpoint-recovery', 'checkpoint-lag', 'repair-exhausted', 'capacity-age', 'capacity-tracks'].map((
                    key
                ) => `alm-${carrier}-${key}`)
            ),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-ordering-gap-repair`),
            'alm-rtc-with-ws-fallback-backpressure-hands-over',
            'alm-rtc-backpressure-refused',
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-backpressure-deferred`),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-own-share-under-inbound`),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-buffered-track-drains`),
            'alm-rtc-churn-bounded-tracks'
        ];
        const cells = toStartedCells(createAlmConformance2AgentEntry());

        expect(defined).toEqual(expect.arrayContaining(withheld));
        expect(new Set(cells)).toEqual(new Set(defined.filter((cell) => !withheld.includes(cell))));
        expect(cells.filter((cell) => cell.endsWith('-delivery-reload'))).toEqual([
            'alm-ws-delivery-reload',
            'alm-rtc-delivery-reload',
            'alm-rtc-with-ws-fallback-delivery-reload'
        ]);
    });

    it('carries the three-agent family in the 3-agent entry, withholding the membership fence, leader and claim cells wherever they run', () => {
        const withheld = [
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.flatMap((carrier) => ['fenced-delivery', 'fenced-catch-up'].map((key) => `alm-${carrier}-${key}`)),
            'alm-ws-fenced-rejection',
            ...ALM_CONFORMANCE_CARRIERS.map((carrier) => `alm-${carrier}-leader-confirms`),
            'alm-ws-no-leader-refused',
            'alm-rtc-no-leader-refused',
            'alm-ws-leader-outside-list',
            'alm-ws-claim-first-wins',
            'alm-rtc-with-ws-fallback-claim-first-wins',
            'alm-ws-claim-expires-reclaims',
            'alm-rtc-claim-refused-on-rtc'
        ];
        const defined = toFamilyCells(['three-agent']);

        expect(defined).toEqual(expect.arrayContaining(withheld));
        expect(new Set(toStartedCells(createAlmConformance3AgentEntry())))
            .toEqual(new Set(defined.filter((cell) => !withheld.includes(cell))));
    });

    // A same-context scenario needs two pages of one browser context, which no hosted agent has.
    it('leaves the same-context family out of every hosted entry', () => {
        const hosted = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()].flatMap(toStartedCells);

        expect(toFamilyCells(['same-context']).filter((cell) => hosted.includes(cell))).toEqual([]);
    });

    // The audience cells' lane evidence is local and the hosted full read's; manifests 18 and 22 stay as recorded.
    it('leaves the same-principal family out of every hosted entry', () => {
        const hosted = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()].flatMap(toStartedCells);
        const samePrincipal = toFamilyCells(['same-principal']);

        expect(samePrincipal).toEqual(expect.arrayContaining(['alm-ws-principal-delivery', 'alm-rtc-world-routing']));
        expect(samePrincipal.filter((cell) => hosted.includes(cell))).toEqual([]);
    });
});

function toBarrierIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command) => command.kind === 'barrier' ? [command.barrierId] : []);
}
