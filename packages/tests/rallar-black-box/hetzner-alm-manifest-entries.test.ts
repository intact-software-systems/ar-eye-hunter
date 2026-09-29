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
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { AL_VOLATILE_SESSION_MAX_ADMISSIONS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    ALM_COMBINED_SCENARIO_BARRIER_TIMEOUT_MS,
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

    it('keeps the capacity sender\'s lowered volatile limits through the combined connect, then restores them', () => {
        const sender = createAlmConformance2AgentEntry().manifest.recipes
            .find((selection) => selection.role === 'sender')!.recipe as RallarBlackBoxTestRecipe;
        const connects = sender.commands.filter((
            command
        ): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect' && command.commandId?.includes('-capacity-sender-') === true);

        expect(connects.map((command) => [command.commandId, command.rallar?.almVolatileLimits]))
            .toEqual(
                ['ws', 'rtc', 'rtc-with-ws-fallback'].flatMap((carrier) => [
                    [`alm-${carrier}-capacity-sender-connect-lowered`, {
                        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
                        maxBytes: 163_840
                    }],
                    [`alm-${carrier}-capacity-sender-connect-restored`, undefined]
                ])
            );
        expect(connects.every((command) => command.readiness?.minReadyPeers === 1)).toBe(true);
    });
});

describe('ALM combined recipient-b ACK-hold ordering', () => {
    it(
        'requires an ack-hold fault that opens a scenario block to follow a previous block long enough for its ' +
            'own ACK to have left, unless that receipt is expected to end expired',
        () => {
            const recipes = createAlmConformance3AgentEntry().manifest.recipes.map(
                (selection) => selection.recipe as RallarBlackBoxTestRecipe
            );
            const senderRecipe = recipes.find((recipe) => recipe.metadata?.role === 'sender')!;
            const recipientBRecipe = recipes.find((recipe) => recipe.metadata?.role === 'recipient-b')!;

            const windowByPrefix = new Map<string, number>();
            const endingByPrefix = new Map<string, RallarBlackBoxTestAssertCommand['expected']>();
            for (const command of senderRecipe.commands) {
                if (
                    command.kind === 'messages.received' && typeof command.commandId === 'string' &&
                    command.commandId.endsWith('-sender-received-self-1')
                ) {
                    windowByPrefix.set(command.commandId.replace(/-sender-received-self-1$/, ''), command.timeoutMs ?? 0);
                }
                if (
                    command.kind === 'assert' && typeof command.commandId === 'string' &&
                    command.source.endsWith('receipts-1.value.state')
                ) {
                    endingByPrefix.set(command.commandId.replace(/-sender-assert-receipt-state-1$/, ''), command.expected);
                }
            }
            expect(windowByPrefix.size).toBeGreaterThan(0);
            expect(endingByPrefix.size).toBe(windowByPrefix.size);

            const prefixOf = (commandId: string | undefined) => commandId?.split('-recipient-b-')[0];
            const commands = recipientBRecipe.commands;
            let checked = 0;
            // Every scenario block ends with its own `stats` command (added by the per-role recipe wrapper); the
            // previous block's own last command — the one that must hold the ACK open — sits just before it.
            for (let i = 2; i < commands.length; i++) {
                const command = commands[i]!;
                if (command.kind !== 'fault.inject' || command.match.controlType !== 'ack' || command.remaining !== 'until-cleared') {
                    continue;
                }
                const currentPrefix = prefixOf(command.commandId);
                // A block opens with its start barrier since D62, so the previous block's `stats` and its last
                // command sit behind that barrier.
                let back = i - 1;
                while (back >= 0 && commands[back]!.kind === 'barrier') {
                    back -= 1;
                }
                const statsCommand = commands[back]!;
                const previousPrefix = prefixOf(statsCommand.commandId);
                if (previousPrefix === undefined || previousPrefix === currentPrefix) {
                    continue;
                }
                expect(statsCommand.kind, `${previousPrefix} -> ${currentPrefix}`).toBe('stats');
                const blockLast = commands[back - 1]!;
                const label = `${previousPrefix} -> ${currentPrefix}`;
                const previousEnding = endingByPrefix.get(previousPrefix);
                expect(previousEnding, label).toBeDefined();
                if (previousEnding === 'expired') {
                    continue;
                }
                checked += 1;
                const requiredMinTimeoutMs = windowByPrefix.get(previousPrefix)!;
                expect(blockLast.kind, label).toBe('messages.received');
                expect(blockLast.kind === 'messages.received' && blockLast.absent, label).toBe(true);
                expect(blockLast.kind === 'messages.received' ? (blockLast.timeoutMs ?? 0) : 0, label)
                    .toBeGreaterThanOrEqual(requiredMinTimeoutMs);
            }
            expect(checked).toBeGreaterThan(0);
        }
    );
});

function toBarrierIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command) => command.kind === 'barrier' ? [command.barrierId] : []);
}

/** Every `alm-<carrier>-<scenarioKey>` block a role recipe runs, read from its own command ids. */
function toScenarioPrefixes(recipe: RallarBlackBoxTestRecipe): ReadonlySet<string> {
    const marker = `-${String(recipe.metadata?.role)}-`;
    return new Set(
        recipe.commands.flatMap((command) =>
            command.kind !== 'barrier' && typeof command.commandId === 'string' && command.commandId.includes(marker)
                ? [command.commandId.slice(0, command.commandId.indexOf(marker))]
                : []
        )
    );
}

function toBarrier(scenarioPrefix: string, role: string, phase: 'start' | 'armed') {
    return {
        kind: 'barrier',
        commandId: `${scenarioPrefix}-${role}-${phase}`,
        barrierId: `${scenarioPrefix}-${phase}`,
        timeoutMs: ALM_COMBINED_SCENARIO_BARRIER_TIMEOUT_MS
    };
}

describe('ALM combined scenario barriers (D62)', () => {
    const entries = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()];

    it('stops every role at a start and an armed barrier per scenario, in one order, and paces nothing', () => {
        for (const entry of entries) {
            const recipes = entry.manifest.recipes.map((selection) => selection.recipe as RallarBlackBoxTestRecipe);
            const order = toBarrierIds(recipes[0]!);
            for (const recipe of recipes) {
                const ids = toBarrierIds(recipe);
                expect(ids, recipe.recipeId).toEqual(order);
                expect(new Set(ids).size, recipe.recipeId).toBe(ids.length);
                const starts = ids.filter((_id, index) => index % 2 === 0);
                expect(starts.every((id) => id.endsWith('-start')), recipe.recipeId).toBe(true);
                expect(ids.filter((_id, index) => index % 2 === 1), recipe.recipeId)
                    .toEqual(starts.map((id) => id.replace(/-start$/, '-armed')));
                expect(new Set(starts.map((id) => id.replace(/-start$/, ''))), recipe.recipeId)
                    .toEqual(toScenarioPrefixes(recipe));
                expect(recipe.commands.some((command) => command.commandId?.endsWith('-combined-pacing')))
                    .toBe(false);
            }
        }
        const [twoAgent, threeAgent] = entries.map((entry) => new Set(toBarrierIds(entry.manifest.recipes[0]!.recipe as RallarBlackBoxTestRecipe)));
        expect([...twoAgent!].filter((id) => threeAgent!.has(id))).toEqual([]);
    });

    it('opens each block at start, arms its faults, meets at armed, then runs its steps; the sender sends after armed', () => {
        for (const entry of entries) {
            for (const selection of entry.manifest.recipes) {
                const recipe = selection.recipe as RallarBlackBoxTestRecipe;
                const role = String(recipe.metadata?.role);
                const ids = recipe.commands.map((command) => command.commandId ?? '');
                const startIndexes = recipe.commands.flatMap((command, index) =>
                    command.kind === 'barrier' && command.barrierId.endsWith('-start') ? [index] : []
                );
                startIndexes.forEach((start, block) => {
                    const scenarioPrefix = ids[start]!.slice(0, ids[start]!.indexOf(`-${role}-start`));
                    const armed = ids.indexOf(`${scenarioPrefix}-${role}-armed`);
                    const blockEnd = startIndexes[block + 1] ?? recipe.commands.length;
                    expect(recipe.commands[start], ids[start]).toEqual(toBarrier(scenarioPrefix, role, 'start'));
                    expect(recipe.commands[armed], ids[start]).toEqual(toBarrier(scenarioPrefix, role, 'armed'));
                    expect(recipe.commands.slice(start + 1, armed).every((command) => command.kind === 'fault.inject'))
                        .toBe(true);
                    expect(recipe.commands[armed + 1]?.kind, ids[start]).not.toBe('fault.inject');
                    // The whole block, and nothing of it before `start`, so every role has finished the previous one.
                    expect(ids.slice(start, blockEnd).every((id) => id.startsWith(`${scenarioPrefix}-`)), ids[start])
                        .toBe(true);
                    expect(
                        ids.slice(0, start).some((id, index) =>
                            id.startsWith(`${scenarioPrefix}-${role}-`) &&
                            !['http.request', 'rtc.connect'].includes(recipe.commands[index]!.kind)
                        ),
                        ids[start]
                    ).toBe(false);
                });
                recipe.commands.forEach((command, index) => {
                    if (command.kind !== 'messages.send' || role !== 'sender') {
                        return;
                    }
                    const scenarioPrefix = ids[index]!.slice(0, ids[index]!.indexOf('-sender-'));
                    expect(ids.indexOf(`${scenarioPrefix}-sender-armed`), ids[index]).toBeGreaterThanOrEqual(0);
                    expect(ids.indexOf(`${scenarioPrefix}-sender-armed`), ids[index]).toBeLessThan(index);
                });
            }
        }
    });

    it('arms recipient-b\'s ACK hold between start and armed, never before the sender closed the previous receipt', () => {
        const recipes = createAlmConformance3AgentEntry().manifest.recipes;
        const toIds = (role: string) =>
            (recipes.find((selection) => selection.role === role)!.recipe as RallarBlackBoxTestRecipe).commands
                .map((command) => command.commandId ?? '');
        const recipientB = toIds('recipient-b');
        const sender = toIds('sender');
        for (const carrier of ['ws', 'rtc', 'rtc-with-ws-fallback']) {
            for (const scenarioKey of ['missing-recipient-retry', 'frozen-audience-membership']) {
                const prefix = `alm-${carrier}-${scenarioKey}`;
                const hold = recipientB.findIndex((id) => id.startsWith(`${prefix}-recipient-b-hold-ack-`));
                expect(hold, prefix).toBeGreaterThan(0);
                expect(recipientB[hold - 1], prefix).toBe(`${prefix}-recipient-b-start`);
                expect(recipientB[hold + 1], prefix).toBe(`${prefix}-recipient-b-armed`);
            }
        }
        // Manifest 22 run 4: recipient-b armed this hold while its ACK for unknown-ack-version was still owed. The hold now
        // waits on the same start barrier the sender reaches only after its receipt assertion for that scenario.
        const nextStart = 'alm-rtc-frozen-audience-membership-start';
        const toBarrierIndex = (role: string) =>
            (recipes.find((selection) => selection.role === role)!.recipe as RallarBlackBoxTestRecipe).commands
                .findIndex((command) => command.kind === 'barrier' && command.barrierId === nextStart);
        const receiptAt = sender.indexOf('alm-rtc-unknown-ack-version-sender-assert-receipt-state-1');
        expect(receiptAt).toBeGreaterThanOrEqual(0);
        expect(toBarrierIndex('sender')).toBeGreaterThan(receiptAt);
        const holdAt = recipientB.findIndex((id) => id.startsWith('alm-rtc-frozen-audience-membership-recipient-b-hold-ack-'));
        expect(toBarrierIndex('recipient-b')).toBeGreaterThanOrEqual(0);
        expect(toBarrierIndex('recipient-b')).toBeLessThan(holdAt);
    });
});
