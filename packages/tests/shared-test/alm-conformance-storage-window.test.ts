import { describe, expect, it } from 'vitest';

import { decodeAlmStorageCountersResultValue } from '@shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';
import type { RallarBlackBoxTestStorageCountersResultValue } from '@shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

function toCounters(
    input: Readonly<{ admission: number; work: number; workPages: number; }>
): RallarBlackBoxTestStorageCountersResultValue {
    return decodeAlmStorageCountersResultValue({
        total: input.admission + input.work,
        byOwner: { 'al-admission': input.admission, 'al-work': input.work },
        byKind: {
            read: input.admission,
            'work-page': input.workPages,
            'work-reserve': input.work - input.workPages
        }
    }, false);
}

async function runStorageWindow(
    recipe: RallarBlackBoxTestRecipe,
    window: RallarBlackBoxTestStorageCountersResultValue
): Promise<boolean> {
    const commands = recipe.commands.filter((command) =>
        command.kind === 'storage.counters' ||
        (command.kind === 'assert' && command.source.includes('storage-window'))
    );
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) => command.kind === 'storage.counters' ? { status: 'ok', value: window } : undefined
    });
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

describe('storage counter window', () => {
    it('splits the probe reads from every other work operation', () => {
        expect(toCounters({ admission: 0, work: 5, workPages: 3 })).toMatchObject({
            workProbeCount: 3,
            workNonProbeCount: 2,
            reset: false
        });
    });

    // R-S3a-11: an idle durable owner's exhausted-retry finalization that finds nothing is its probe too.
    it('counts the idle finalization probe beside the page probes and reports whether the reading reset', () => {
        expect(decodeAlmStorageCountersResultValue({
            total: 5,
            byOwner: { 'al-admission': 0, 'al-work': 5 },
            byKind: { 'work-page': 3, 'work-probe': 2 }
        }, true)).toMatchObject({ workProbeCount: 5, workNonProbeCount: 0, reset: true });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'pins zero admission and zero non-probe work on both volatile-default pages over %s',
        async (carrier) => {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((
                candidate
            ) => candidate.scenarioId === 'volatile-default')!;
            for (const recipe of [scenario.sender, scenario.receiver]) {
                // The sender's connected reading comes first on every scenario; the window opens after it.
                const opening = recipe.commands.find((command) =>
                    command.kind === 'storage.counters' && command.commandId?.endsWith('storage-window-open') === true
                );
                expect(opening, recipe.recipeId).toMatchObject({ reset: true });
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(true);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 1, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 5, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
            }
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'requires admission operations on both durable-opt-in pages over %s',
        async (carrier) => {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((
                candidate
            ) => candidate.scenarioId === 'durable-opt-in')!;
            const send = scenario.sender.commands.find((command) => command.kind === 'messages.send');
            expect(send).toMatchObject({ durability: 'local-inbox' });
            for (const recipe of [scenario.sender, scenario.receiver]) {
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 3, work: 4, workPages: 1 })
                    ),
                    recipe.recipeId
                ).toBe(true);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
            }
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'keeps each new recipient inside its scenario until its acknowledgement has left over %s',
        (carrier) => {
            for (const scenarioId of ['volatile-default', 'durable-opt-in']) {
                const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((candidate) => candidate.scenarioId === scenarioId)!;
                const commands = scenario.receiver.commands;
                expect(commands.at(-2), scenario.receiver.recipeId).toMatchObject({
                    kind: 'messages.received',
                    absent: true,
                    windowMs: 17_000
                });
            }
        }
    );
});
