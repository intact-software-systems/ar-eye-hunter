import {
    describe,
    expect,
    it
} from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    ALM_CONFORMANCE_WORLD_SEND_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
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
import { toNestedCommands } from '../shared-test/to-nested-commands.ts';

/** No generated scenario carries a request of its own today, so the fixture places one first in the sender's body. */
function withInScenarioRequest(scenario: AlmConformanceScenario): AlmConformanceScenario {
    const parts = scenario.partsByRole.sender!;
    const request: RallarBlackBoxTestCommand = {
        kind: 'http.request',
        commandId: 'in-scenario-request',
        request: { method: 'GET', path: '/api/state/apps/app/workspaces/ws/groups/room-alm' }
    };
    return { ...scenario, partsByRole: { ...scenario.partsByRole, sender: { ...parts, body: [request, ...parts.body] } } };
}

describe('ALM conformance combined recipe', () => {
    it('shares one prologue and keeps a request that is a step inside a scenario', () => {
        const [baseline, expires] = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            carrier: 'rtc',
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000,
            laneFamilies: ['two-agent'],
            principalIdsByRole: {}
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
        ): command is RallarBlackBoxTestRtcConnectCommand =>
            command.kind === 'rtc.connect' && /^alm-(ws|rtc|rtc-with-ws-fallback)-capacity-sender-/.test(command.commandId ?? '')
        );

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

    it('keeps the paced capacity sender\'s lowered publication limits through the combined connect, then restores them', () => {
        const sender = createAlmConformance2AgentEntry().manifest.recipes
            .find((selection) => selection.role === 'sender')!.recipe!;
        const connects = sender.commands.filter((
            command
        ): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect' && command.commandId?.includes('-paced-capacity-sender-') === true);

        expect(connects.map((command) => [command.commandId, command.rallar?.almPublicationLimits]))
            .toEqual(
                ['ws', 'rtc', 'rtc-with-ws-fallback'].flatMap((carrier) => [
                    [`alm-${carrier}-paced-capacity-sender-connect-lowered`, {
                        maxStreams: 64,
                        maxStagedValues: 2,
                        maxStagedBytes: 4_194_304
                    }],
                    [`alm-${carrier}-paced-capacity-sender-connect-restored`, undefined]
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
            deadlineMs: 18_000,
            laneFamilies: families,
            principalIdsByRole: { sender: 'principal-alice', receiver: 'principal-bob', 'publisher-b': 'principal-charlie' }
        }).map((scenario) => `alm-${carrier}-${scenario.scenarioKey}`)
    );
}

function toStartedCells(entry: ReturnType<typeof createAlmConformance2AgentEntry>): readonly string[] {
    const sender = entry.manifest.recipes
        .find((selection) => selection.role === 'sender')!.recipe!;
    return toBarrierIds(sender).filter((id) => id.endsWith('-start')).map((id) => id.replace(/-start$/, ''));
}

describe('ALM conformance hosted lane families', () => {
    it('withholds exactly the named cells: both checkpoint cells and the age bound cell everywhere, the track bound cell where it runs, the gap repair, the congestion, the fairness, and the reply and the server-originated cells where they run', () => {
        const defined = toFamilyCells(['two-agent', 'addressed']);
        // Removing a withheld cell from hosted manifest 18 is a deliberate act: the checkpoint, repair, volatile
        // bound, congestion and fairness cells keep manifest 18 as recorded.
        const withheldEverywhere = ['checkpoint-recovery', 'checkpoint-lag', 'capacity-age'];
        const withheld = [
            ...ALM_CONFORMANCE_CARRIERS.flatMap((carrier) => withheldEverywhere.map((key) => `alm-${carrier}-${key}`)),
            ...ALM_CONFORMANCE_WORLD_SEND_CARRIERS.map((carrier) => `alm-${carrier}-capacity-tracks`),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-ordering-gap-repair`),
            'alm-rtc-with-ws-fallback-backpressure-hands-over',
            'alm-rtc-backpressure-refused',
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-backpressure-deferred`),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-own-share-under-inbound`),
            ...ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.map((carrier) => `alm-${carrier}-buffered-track-drains`),
            'alm-rtc-churn-bounded-tracks',
            'alm-ws-reply-correlated',
            'alm-rtc-with-ws-fallback-reply-correlated',
            'alm-ws-reply-timeout-late',
            'alm-ws-reply-undelivered',
            // The combined connect's one selector is the scenario topic's, so no hosted page hears a group-state delta.
            'alm-ws-server-originated',
            // A granted cell's grants name principals, which a hosted manifest's agents are not known by (D505).
            ...[
                'granted-rtc-delivered',
                'granted-rtc-missing-proof',
                'granted-rtc-publish-refused',
                'granted-rtc-receipted-delivered',
                'granted-rtc-revoked-publisher',
                'granted-rtc-unicast-delivered'
            ].map((key) => `alm-rtc-${key}`),
            'alm-rtc-with-ws-fallback-granted-rtc-revoked-publisher'
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

    it('carries the three-agent family in the 3-agent entry, withholding the membership fence, leader, claim, reply, paced list-isolation and exhausted repair cells wherever they run', () => {
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
            'alm-rtc-claim-refused-on-rtc',
            'alm-ws-reply-first-wins',
            // A hosted run proves the paced send shape on three agents first (D481).
            ...ALM_CONFORMANCE_CARRIERS.map((carrier) => `alm-${carrier}-paced-isolation-lists`),
            // The exhausted repair's lane evidence is local and the hosted full read's; manifest 22 stays as recorded.
            'alm-rtc-repair-exhausted',
            'alm-rtc-unsigned-ack-refused',
            'alm-rtc-with-ws-fallback-unsigned-ack-refused',
            'alm-rtc-forged-recipient-ack',
            'alm-rtc-receipted-relay-path'
        ];
        const defined = toFamilyCells(['three-agent']);

        expect(defined).toEqual(expect.arrayContaining(withheld));
        expect(new Set(toStartedCells(createAlmConformance3AgentEntry())))
            .toEqual(new Set(defined.filter((cell) => !withheld.includes(cell))));
    });

    it('runs every cell whose sender closes after all the others, so no reconnect lands among the ordinary cells', () => {
        const closingSenders = new Set(ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
            createAlmConformanceRecipes({
                group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
                carrier,
                typeId: 'alm.conformance',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000,
                laneFamilies: ['two-agent', 'addressed', 'three-agent'],
                principalIdsByRole: {}
            }).filter((scenario) => scenario.sender.commands.some((command) => command.kind === 'close'))
                .map((scenario) => scenario.scenarioKey)
        ));
        // A cell that gains a sender close joins this list and the ordering below.
        expect([...closingSenders]).toEqual(['capacity', 'capacity-tracks', 'paced-capacity', 'churn-bounded-tracks']);

        const cells = toStartedCells(createAlmConformance2AgentEntry());
        const isClosing = (cell: string) => [...closingSenders].some((key) => cell.endsWith(`-${key}`));
        const firstClosing = cells.findIndex(isClosing);
        expect(firstClosing).toBeGreaterThan(0);
        expect(cells.slice(firstClosing).every(isClosing)).toBe(true);
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

describe('ALM conformance combined blocks', () => {
    it('a combined block carries its cell\'s history mark on every wait and nothing of the cell\'s prologue', () => {
        const prologueCommandIds = new Set(ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
            createAlmConformanceRecipes({
                group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
                carrier,
                typeId: 'alm.conformance',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000,
                laneFamilies: ['two-agent', 'addressed', 'three-agent'],
                principalIdsByRole: {}
            }).flatMap((scenario) => Object.values(scenario.partsByRole).flatMap((parts) => parts.prologue.map((command) => command.commandId)))
        ));
        const selections = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()]
            .flatMap((entry) => entry.manifest.recipes);

        for (const selection of selections) {
            const role = selection.role!;
            const blocks = toCombinedBlocks(selection.recipe!);
            expect(blocks.length).toBeGreaterThan(0);
            for (const { cell, commands } of blocks) {
                const nested = toNestedCommands(commands);
                expect(nested.filter((command) => prologueCommandIds.has(command.commandId)), cell).toEqual([]);
                for (const command of nested) {
                    if (command.kind === 'wait') {
                        // Exactly one of the two: the cell's mark, or the declaration that it reads the page's history.
                        const marked = command.match.sinceCommandIdPrefix !== undefined;
                        const pageHistory = command.metadata?.historyFrom === 'page';
                        expect(marked !== pageHistory, command.commandId).toBe(true);
                        if (marked) {
                            expect(command.match.sinceCommandIdPrefix, command.commandId).toBe(`${cell}-${role}-`);
                        }
                    }
                }
            }
        }
    });

    it('a cell\'s command ids, its lane barrier and its combined block barriers share one command prefix on every carrier', () => {
        const toBaseline = (carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number], cellSettle?: 'barriered') =>
            createAlmConformanceRecipes({
                group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
                carrier,
                typeId: 'alm.conformance',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000,
                laneFamilies: ['two-agent'],
                principalIdsByRole: {},
                ...(cellSettle === undefined ? {} : { cellSettle })
            }).find((scenario) => scenario.scenarioKey === 'delivery-baseline')!;

        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = toBaseline(carrier);
            const combined = toAlmConformanceCombinedRecipe(
                carrier === 'rtc' ? [scenario] : [toBaseline('rtc'), scenario],
                'sender',
                'two-agent'
            );
            const laneBarrier = toNestedCommands(toBaseline(carrier, 'barriered').sender.commands)
                .find((command): command is RallarBlackBoxTestBarrierCommand => command.kind === 'barrier')!;
            const prefixes = [
                scenario.sender.commands[0]!.commandId!.replace(/-sender-ensure-group$/, ''),
                laneBarrier.barrierId.replace(/-connected$/, ''),
                toCombinedBlocks(combined).at(-1)!.cell
            ];

            expect(prefixes, carrier).toEqual(Array.from(prefixes, () => `alm-${carrier}-delivery-baseline`));
        }
    });

    it('no combined block carries a cell gate', () => {
        const selections = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()]
            .flatMap((entry) => entry.manifest.recipes);

        for (const selection of selections) {
            for (const { cell, commands } of toCombinedBlocks(selection.recipe!)) {
                const barriers = toNestedCommands(commands).filter((command) => command.kind === 'barrier');
                // The run's every started agent meets at each block's two barriers; no barrier names its participants.
                expect(barriers, cell).toEqual([{
                    kind: 'barrier',
                    commandId: `${cell}-${selection.role}-armed`,
                    barrierId: `${cell}-armed`,
                    timeoutMs: expect.any(Number)
                }]);
            }
        }
    });
});

/** Each cell's block runs from its `start` barrier to the next cell's; the shared prologue precedes the first. */
function toCombinedBlocks(
    recipe: RallarBlackBoxTestRecipe
): readonly { readonly cell: string; readonly commands: readonly RallarBlackBoxTestCommand[]; }[] {
    const starts = recipe.commands.flatMap((command, index) => command.kind === 'barrier' && command.barrierId.endsWith('-start') ? [index] : []);
    return starts.map((start, position) => {
        const barrier = recipe.commands[start] as RallarBlackBoxTestBarrierCommand;
        return {
            cell: barrier.barrierId.replace(/-start$/, ''),
            commands: recipe.commands.slice(start + 1, starts[position + 1] ?? recipe.commands.length)
        };
    });
}

function toBarrierIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command) => command.kind === 'barrier' ? [command.barrierId] : []);
}
