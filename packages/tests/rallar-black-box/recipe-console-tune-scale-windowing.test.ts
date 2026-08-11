// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { rememberControlResponseDocument } from
    '../../../apps/rallar-black-box/src/control-response-document.ts';
import { createControlSnapshotRevisionSession } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-snapshot-revision.ts';
import { createRecipeConsoleTuneScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/recipe-console-tune-scale-fixture.ts';
import { inventoryDistributedRunTuningKnobs } from
    '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning.ts';
import { buildTuneRunCatalog } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-catalog.ts';
import { deriveTuneSelectionModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-selection-model.ts';
import { createTuneCandidateKnobIndex } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-candidate-knob-index.ts';
import type { TuneSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-model.ts';
import { TuneKnobInventory } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/TuneKnobInventory.tsx';
import { TuneKnobPicker } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/TuneKnobPicker.tsx';
import { TuneRunPicker } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/TuneRunPicker.tsx';
import { createTuneRunPickerModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-picker-model.ts';
import {
    createTuneRunCatalogCache,
    tuneRunCatalogCacheWorkForTest,
} from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-catalog-cache.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const RUN_COUNT = 5_000;

describe('Recipe Console Tune scale windowing', () => {
    it('indexes 5,000 paired runs linearly and derives only two requested performances', () => {
        const distributedRuns = Array.from(
            { length: RUN_COUNT },
            (_, index) => distributedRun(index),
        );
        const controlRuns = Array.from(
            { length: RUN_COUNT },
            (_, index) => controlRun(index),
        );
        const performanceRunIds = ['run-000123', 'run-004999'];

        const catalog = buildTuneRunCatalog({
            controlRuns,
            distributedRuns,
            performanceRunIds,
        });

        expect(catalog.options).toHaveLength(RUN_COUNT);
        expect(catalog.quarantined).toEqual([]);
        expect(catalog.work).toEqual({
            controlRowsIndexed: RUN_COUNT,
            distributedRowsIndexed: RUN_COUNT,
            distributedIdentitiesVisited: RUN_COUNT,
            identityProjections: RUN_COUNT,
            manifestIdentityChecks: RUN_COUNT,
            manifestValidations: 2,
            selectionBoundaryManifestValidations: 0,
            selectionBoundaryPerformanceDerivations: 0,
            selectionBoundaryProjectionReuses: 0,
            retainedArtifactManifestValidations: 0,
            retainedFacadeManifestValidations: 0,
            controlPairLookups: RUN_COUNT,
            performanceDerivations: 2,
            retainedArtifactProjections: 0,
            retainedFacadeProjections: 0,
        });
        expect(catalog.options.filter(option => option.performance)).toHaveLength(2);
        expect(catalog.options.filter(option => option.performance)
            .map(option => option.distributedRunId).sort()).toEqual(performanceRunIds);
        expect(JSON.stringify(catalog.work)).not.toMatch(/run-|control-|agent-|recipe-/u);
    });

    it('bounds the ordinary Tune selection path to its explicit comparison pair', () => {
        const distributedRuns = Array.from(
            { length: RUN_COUNT },
            (_, index) => distributedRun(index),
        );
        const controlRuns = Array.from(
            { length: RUN_COUNT },
            (_, index) => controlRun(index),
        );

        const selection = deriveTuneSelectionModel({
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                compareLeft: 'run-000123',
                compareRight: 'run-004999',
            },
            query: {
                status: 'live',
                reachability: 'reachable',
                authorization: 'ready',
                snapshot: { distributedRuns, runs: controlRuns },
                receivedAtEpochMs: 10_000,
                isRefreshing: false,
            },
        });

        expect(selection.comparison.state).toBe('ready');
        expect(selection.options.filter(option => option.performance)).toHaveLength(2);
        expect(selection.options.find(option =>
            option.distributedRunId === 'run-004998'
        )?.performance).toBeUndefined();
    });

    it('reuses the 5,000-run catalog for an exact cloned poll and misses changed truth',
        () => {
            const first: ControlServerSnapshot = {
                distributedRuns: Array.from(
                    { length: RUN_COUNT },
                    (_, index) => distributedRun(index),
                ),
                runs: Array.from(
                    { length: RUN_COUNT },
                    (_, index) => controlRun(index),
                ),
            };
            const same = structuredClone(first);
            const changed = structuredClone(first);
            changed.distributedRuns![4_998] = {
                ...changed.distributedRuns![4_998]!,
                state: 'failed',
            };
            const revisions = createControlSnapshotRevisionSession();
            for (const snapshot of [first, same, changed]) {
                rememberControlResponseDocument(snapshot, JSON.stringify(snapshot));
                revisions.associate(snapshot, {
                    source: 'root-snapshot',
                    rootDocument: snapshot,
                });
            }
            const cache = createTuneRunCatalogCache();
            const performanceRunIds = ['run-000123', 'run-004999'];

            const firstCatalog = cache.get({ snapshot: first, performanceRunIds });
            const sameCatalog = cache.get({ snapshot: same, performanceRunIds });

            expect(sameCatalog).toBe(firstCatalog);
            expect(tuneRunCatalogCacheWorkForTest(cache)).toMatchObject({
                lookupCount: 2,
                hitCount: 1,
                missCount: 1,
                catalogBuildCount: 1,
                lastLookup: {
                    cacheHit: true,
                    catalogBuildCount: 0,
                    build: {
                        controlRowsIndexed: 0,
                        distributedRowsIndexed: 0,
                        manifestValidations: 0,
                        performanceDerivations: 0,
                    },
                },
            });

            const changedCatalog = cache.get({
                snapshot: changed,
                performanceRunIds,
            });
            expect(changedCatalog).not.toBe(firstCatalog);
            expect(changedCatalog.optionsByDistributedRunId.get('run-004998')
                ?.distributedRun.state).toBe('failed');
            const work = tuneRunCatalogCacheWorkForTest(cache);
            expect(work).toMatchObject({
                lookupCount: 3,
                hitCount: 1,
                missCount: 2,
                catalogBuildCount: 2,
                lastLookup: {
                    cacheHit: false,
                    catalogBuildCount: 1,
                    build: {
                        controlRowsIndexed: RUN_COUNT,
                        distributedRowsIndexed: RUN_COUNT,
                        manifestIdentityChecks: RUN_COUNT,
                        manifestValidations: 2,
                        performanceDerivations: 2,
                    },
                },
            });
            expect(JSON.stringify(work)).not.toMatch(
                /run-|control-|agent-|recipe-/u,
            );
        });

    });

describe('Recipe Console Tune pressure UI', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    it('uses concise missing-selection placeholders and keeps invalid truth adjacent',
        async () => {
            const navigate = vi.fn();
            const missing = scaleSelection(undefined, undefined);
            root = createRoot(container);
            await act(async () => root?.render(createElement(TuneRunPicker, {
                field: 'compareLeft',
                model: createTuneRunPickerModel(missing),
                navigate,
                selection: missing,
            })));

            expect(container.querySelector('#tune-compareLeft-selection')?.textContent)
                .toBe('Select baseline');
            expect(container.querySelector('[data-tune-run-picker-issue]')).toBeNull();

            const invalid = scaleSelection('run-missing', 'run-000123');
            await act(async () => root?.render(createElement(TuneRunPicker, {
                field: 'compareLeft',
                model: createTuneRunPickerModel(invalid),
                navigate,
                selectedKey: 'run-missing',
                selection: invalid,
            })));
            const trigger = container.querySelector(
                '[data-searchable-listbox-trigger]',
            );
            expect(trigger?.getAttribute('aria-invalid')).toBe('true');
            expect(trigger?.getAttribute('aria-describedby'))
                .toBe('tune-compareLeft-issue');
            expect(container.querySelector('[data-tune-run-picker-issue]')?.textContent)
                .toBe('compareLeft is not available in retained artifact or control evidence.');

            const sameRun = scaleSelection('run-000123', 'run-000123');
            await act(async () => root?.render(createElement(TuneRunPicker, {
                field: 'compareRight',
                model: createTuneRunPickerModel(sameRun),
                navigate,
                selectedKey: 'run-000123',
                selection: sameRun,
            })));
            expect(container.querySelector('[data-tune-run-picker-issue]')?.textContent)
                .toBe('Baseline and candidate must be different runs.');
        });

    it('mounts at most 100 of 5,000 runs and reaches a late selected ID', async () => {
        const selection = scaleSelection('run-004999', 'run-000123');
        const navigate = vi.fn();
        root = createRoot(container);
        await act(async () => root?.render(createElement(TuneRunPicker, {
            field: 'compareRight',
            model: createTuneRunPickerModel(selection),
            navigate,
            selectedKey: 'run-000123',
            selection,
        })));

        expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
        await click(container.querySelector('[data-searchable-listbox-trigger]'));
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
        expect(container.querySelector('[role="option"][aria-selected="true"]')
            ?.getAttribute('data-option-key')).toBe('run-000123');
        expect(container.querySelector('[data-searchable-listbox-range]')?.textContent)
            .toBe('Showing 4,801–4,900 of 5,000 options.');

        await click(button('Previous'));
        expect(navigate).not.toHaveBeenCalled();
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
        await click(container.querySelector('[role="option"]'));
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('keeps an open queried run page stable across a clone-equivalent poll',
        async () => {
            const navigate = vi.fn();
            const render = (selection = scaleSelection(
                'run-004999',
                'run-000123',
            )) => root?.render(createElement(TuneRunPicker, {
                field: 'compareRight',
                model: createTuneRunPickerModel(selection),
                navigate,
                selectedKey: 'run-000123',
                selection,
            }));
            root = createRoot(container);
            await act(async () => render());
            await click(container.querySelector('[data-searchable-listbox-trigger]'));
            await setSearch(container, 'run-00');
            await click(button('Next'));
            await click(button('Next'));
            const range = container.querySelector(
                '[data-searchable-listbox-range]',
            )?.textContent;
            expect(range).toBe('Showing 201–300 of 5,000 options.');

            await act(async () => render());

            expect(container.querySelector<HTMLInputElement>(
                'input[type="search"]',
            )?.value).toBe('run-00');
            expect(container.querySelector(
                '[data-searchable-listbox-range]',
            )?.textContent).toBe(range);
            expect(container.querySelector('[data-searchable-listbox-popup]'))
                .not.toBeNull();
            expect(navigate).not.toHaveBeenCalled();
        });

    it('indexes and reaches a late long-bidi pointer among 24,002 editable knobs',
        async () => {
            const fixture = createRecipeConsoleTuneScaleFixture();
            const inventory = inventoryDistributedRunTuningKnobs(fixture.manifest);
            const source = {
                inventory,
                decisions: undefined,
            } as unknown as TuneSourceModel;
            const index = createTuneCandidateKnobIndex(source);
            const pointer = inventory.knobs.find(knob =>
                knob.commandId === fixture.needles.commandIds.longBidi &&
                knob.name === 'maxInFlight'
            )?.pointer;
            expect(pointer).toBeDefined();
            expect(index.work).toEqual({
                knobRowsVisited: 24_002,
                editableOptionsProjected: 24_002,
                blockedRowsProjected: 0,
                uniquePointersIndexed: 24_002,
                revisionRowsProjected: 24_002,
                hintRowsVisited: 0,
            });
            expect(JSON.stringify(index.work))
                .not.toContain(fixture.needles.commandIds.longBidi);

            const onSelect = vi.fn();
            root = createRoot(container);
            await act(async () => root?.render(createElement(TuneKnobPicker, {
                contextKey: 'scale-knobs',
                index,
                onSelect,
                selectedPointer: pointer,
            })));
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            await click(container.querySelector('[data-searchable-listbox-trigger]'));
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
            const selected = container.querySelector<HTMLElement>(
                '[role="option"][aria-selected="true"]',
            );
            expect(selected?.getAttribute('data-option-key')).toBe(pointer);
            expect(index.options.find(option => option.key === pointer)?.searchText)
                .toContain(fixture.needles.commandIds.longBidi);
            await click(selected);
            expect(onSelect).toHaveBeenCalledWith(pointer);
        });

    it('keeps an open queried knob page stable across equivalent re-inventory',
        async () => {
            const fixture = createRecipeConsoleTuneScaleFixture();
            const inventory = inventoryDistributedRunTuningKnobs(fixture.manifest);
            const source = {
                inventory,
                decisions: undefined,
            } as unknown as TuneSourceModel;
            const selectedPointer = inventory.knobs.find(knob =>
                knob.commandId === fixture.needles.commandIds.longBidi &&
                knob.name === 'maxInFlight'
            )?.pointer;
            expect(selectedPointer).toBeDefined();
            const render = (nextSource: TuneSourceModel) => root?.render(
                createElement(TuneKnobPicker, {
                    contextKey: 'scale-knobs',
                    index: createTuneCandidateKnobIndex(nextSource),
                    onSelect: vi.fn(),
                    selectedPointer,
                }),
            );
            root = createRoot(container);
            await act(async () => render(source));
            await click(container.querySelector('[data-searchable-listbox-trigger]'));
            await setSearch(container, 'scale-stream');
            await click(button('Next'));
            const range = container.querySelector(
                '[data-searchable-listbox-range]',
            )?.textContent;
            expect(range).toMatch(/^Showing [\d,]+–[\d,]+ of 24,000 options\.$/u);

            await act(async () => render(structuredClone(source)));

            expect(container.querySelector<HTMLInputElement>(
                'input[type="search"]',
            )?.value).toBe('scale-stream');
            expect(container.querySelector(
                '[data-searchable-listbox-range]',
            )?.textContent).toBe(range);
            expect(container.querySelector('[data-searchable-listbox-popup]'))
                .not.toBeNull();
        });

    it('fails the knob picker closed when duplicate pointer keys reach the UI',
        async () => {
            const fixture = createRecipeConsoleTuneScaleFixture({ commandCount: 4 });
            const original = inventoryDistributedRunTuningKnobs(
                fixture.manifest,
            ).knobs[0]!;
            const source = {
                inventory: { knobs: [original, { ...original }], limitations: [] },
                decisions: undefined,
            } as unknown as TuneSourceModel;
            const index = createTuneCandidateKnobIndex(source);
            const onSelect = vi.fn();
            root = createRoot(container);
            await act(async () => root?.render(createElement(TuneKnobPicker, {
                contextKey: 'duplicate-knobs',
                index,
                onSelect,
                selectedPointer: original.pointer,
            })));

            await click(container.querySelector('[data-searchable-listbox-trigger]'));

            expect(container.querySelector('[role="alert"]')?.textContent)
                .toContain('option keys must be unique');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(onSelect).not.toHaveBeenCalled();
            expect(index.work).toMatchObject({
                knobRowsVisited: 2,
                editableOptionsProjected: 2,
                uniquePointersIndexed: 1,
                revisionRowsProjected: 2,
            });
        });

    it('keeps blocked evidence explicit and browseable within 100 mounted rows',
        async () => {
            const fixture = createRecipeConsoleTuneScaleFixture({ commandCount: 24 });
            const knobs = inventoryDistributedRunTuningKnobs(fixture.manifest).knobs
                .slice(0, 240)
                .map(knob => ({
                    ...knob,
                    availability: 'blocked' as const,
                    effective: false,
                    reason: 'Blocked scale evidence.',
                }));
            root = createRoot(container);
            const source = {
                inventory: { knobs, limitations: [] },
                decisions: undefined,
            } as unknown as TuneSourceModel;
            await act(async () => root?.render(createElement(TuneKnobInventory, {
                index: createTuneCandidateKnobIndex(source),
                onInspect: vi.fn(),
            })));

            expect(container.querySelectorAll('[data-tune-blocked-knob]'))
                .toHaveLength(100);
            expect(container.querySelector('[data-tune-blocked-knobs-outside]')
                ?.textContent).toContain('140 blocked knobs outside this window and browseable');
            await click(button('Next'));
            expect(container.querySelectorAll('[data-tune-blocked-knob]'))
                .toHaveLength(100);
            const range = container.querySelector(
                '[data-tune-blocked-focus-anchor]',
            )?.textContent;
            expect(range).toBe('Showing 101–200 of 240 blocked knobs.');

            await act(async () => root?.render(createElement(TuneKnobInventory, {
                index: createTuneCandidateKnobIndex(structuredClone(source)),
                onInspect: vi.fn(),
            })));

            expect(container.querySelector(
                '[data-tune-blocked-focus-anchor]',
            )?.textContent).toBe(range);
        });

    function button(name: string): HTMLButtonElement | null {
        return [...container.querySelectorAll('button')]
            .find(row => row.textContent?.trim() === name) ?? null;
    }
});

async function click(element: Element | null): Promise<void> {
    if (!(element instanceof HTMLElement)) throw new Error('Expected clickable element.');
    await act(async () => element.click());
}

async function setSearch(container: HTMLElement, value: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>(
        'input[type="search"][role="combobox"]',
    );
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    )?.set;
    if (!input || !setter) throw new Error('Expected searchable input.');
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function scaleSelection(left: string | undefined, right: string | undefined) {
    const distributedRuns = Array.from(
        { length: RUN_COUNT },
        (_, index) => distributedRun(index),
    );
    const controlRuns = Array.from(
        { length: RUN_COUNT },
        (_, index) => controlRun(index),
    );
    return deriveTuneSelectionModel({
        urlState: {
            v: 1,
            experience: 'recipe-console',
            view: 'tune',
            compareLeft: left,
            compareRight: right,
        },
        query: {
            status: 'live',
            reachability: 'reachable',
            authorization: 'ready',
            snapshot: { distributedRuns, runs: controlRuns },
            receivedAtEpochMs: 10_000,
            isRefreshing: false,
        },
    });
}

function distributedRun(index: number): ControlDistributedRunSnapshot {
    const id = sequence('run', index);
    const controlId = sequence('control', index);
    const commandId = sequence('command', index);
    return {
        distributedRunId: id,
        controlRunId: controlId,
        state: 'passed',
        createdAtEpochMs: index,
        updatedAtEpochMs: index,
        startedAtEpochMs: index,
        completedAtEpochMs: index + 100,
        targetAgentIds: ['agent-a'],
        commandLinks: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId: id,
            controlRunId: controlId,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a',
            },
            targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
            recipes: [{
                recipeId: 'recipe-a',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'recipe-a',
                    commands: [{ kind: 'health', commandId }],
                },
            }],
        },
        rollup: {
            state: 'passed',
            ok: true,
            failures: [],
            summary: { blockingFailures: 0 },
        },
    };
}

function controlRun(index: number): ControlRunSnapshot {
    const id = sequence('control', index);
    return {
        runId: id,
        createdAtEpochMs: index,
        updatedAtEpochMs: index + 100,
        agents: [],
        commands: [{
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: id,
                agentId: 'agent-a',
                commandId: sequence('command', index),
                command: { kind: 'health' },
            },
            queuedAtEpochMs: index + 10,
            completedAtEpochMs: index + 20,
            dispatchCount: 1,
        }],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function sequence(prefix: string, index: number): string {
    return `${prefix}-${String(index).padStart(6, '0')}`;
}
