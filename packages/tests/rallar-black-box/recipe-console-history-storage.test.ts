// @vitest-environment happy-dom
import { createElement, StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    HISTORY_FILTER_PRESET_LIMITS,
    createHistoryFilterPreset,
    historyFilterPresetApplyPatch,
    removeHistoryFilterPreset,
    upsertHistoryFilterPreset,
    type HistoryFilterPreset,
} from '../../../apps/rallar-black-box/src/recipe-console/history/history-filter-contract.ts';
import {
    HISTORY_FILTER_PRESET_STORAGE_KEY,
    HISTORY_FILTER_PRESET_MAX_INPUT_COUNT,
    HISTORY_FILTER_PRESET_MAX_SERIALIZED_LENGTH,
    deserializeHistoryFilterPresets,
    parseHistoryFilterPresetEnvelope,
    readHistoryFilterPresets,
    serializeHistoryFilterPresets,
    writeHistoryFilterPresets,
    type HistoryFilterStorage,
} from '../../../apps/rallar-black-box/src/recipe-console/history/history-filter-storage.ts';
import {
    useHistoryFilterPresets,
    type HistoryFilterPresetController,
} from '../../../apps/rallar-black-box/src/recipe-console/history/use-history-filter-presets.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
};

function state(
    overrides: Partial<RecipeConsoleUrlState> = {},
): RecipeConsoleUrlState {
    return { ...BASE_STATE, ...overrides };
}

function preset(
    name: string,
    filters: HistoryFilterPreset['filters'] = {},
): HistoryFilterPreset {
    return { name, filters };
}

class MemoryStorage implements HistoryFilterStorage {
    readonly values = new Map<string, string>();
    getError?: Error;
    setError?: Error;
    removeError?: Error;
    setCalls = 0;
    removeCalls = 0;

    getItem(key: string): string | null {
        if (this.getError) throw this.getError;
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.setCalls += 1;
        if (this.setError) throw this.setError;
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.removeCalls += 1;
        if (this.removeError) throw this.removeError;
        this.values.delete(key);
    }
}

describe('Recipe Console History filter contract', () => {
    it('persists exactly the eight committed History filters and applies a replacement patch', () => {
        const committedWithForbiddenState = {
            ...state({
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'history-recipe',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: 100,
            to: 900,
            recipeId: 'operational-secret',
            controlRunId: 'control-secret',
            distributedRunId: 'distributed-secret',
            compareLeft: 'compare-left-secret',
            compareRight: 'compare-right-secret',
            timingMetric: 'stream-cadence',
            }),
            controlToken: 'cast-control-token-secret',
            controlUrl: 'https://cast-control-url-secret.test',
            artifact: { payload: 'cast-artifact-secret' },
            draft: 'cast-draft-secret',
            activePreset: 'cast-active-preset-secret',
        } as RecipeConsoleUrlState;
        const created = createHistoryFilterPreset(
            '  Failed ACKs  ',
            committedWithForbiddenState,
        );

        expect(created).toEqual({
            name: 'Failed ACKs',
            filters: {
                historyQuery: 'failed ack',
                historyGroup: 'bb-group',
                historyRecipeId: 'history-recipe',
                historyProfile: 'smoke',
                failureCategory: 'readiness',
                status: 'failed',
                from: 100,
                to: 900,
            },
        });
        expect(JSON.stringify(created)).not.toMatch(
            /operational-secret|control-secret|distributed-secret|compare-|stream-cadence|cast-/,
        );
        expect(historyFilterPresetApplyPatch(preset('Partial', {
            historyGroup: 'only-this-group',
        }))).toEqual({
            historyQuery: undefined,
            historyGroup: 'only-this-group',
            historyRecipeId: undefined,
            historyProfile: undefined,
            failureCategory: undefined,
            status: undefined,
            from: undefined,
            to: undefined,
        });
    });

    it('enforces name and committed-filter bounds without truncation', () => {
        expect(createHistoryFilterPreset(' ', BASE_STATE)).toBeUndefined();
        expect(createHistoryFilterPreset(
            'n'.repeat(HISTORY_FILTER_PRESET_LIMITS.name + 1),
            BASE_STATE,
        )).toBeUndefined();
        expect(createHistoryFilterPreset('Query boundary', state({
            historyQuery: 'q'.repeat(HISTORY_FILTER_PRESET_LIMITS.query),
            historyGroup: 'g'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
        }))).toBeDefined();
        expect(createHistoryFilterPreset('Query too long', state({
            historyQuery: 'q'.repeat(HISTORY_FILTER_PRESET_LIMITS.query + 1),
        }))).toBeUndefined();
        expect(createHistoryFilterPreset('Group too long', state({
            historyGroup: 'g'.repeat(HISTORY_FILTER_PRESET_LIMITS.string + 1),
        }))).toBeUndefined();
        expect(createHistoryFilterPreset('Bad range', state({
            from: 901,
            to: 900,
        }))).toBeUndefined();
    });

    it('replaces an exact normalized duplicate as newest and evicts the oldest at twelve', () => {
        let presets: readonly HistoryFilterPreset[] = [];
        for (let index = 1; index <= 12; index += 1) {
            presets = upsertHistoryFilterPreset(
                presets,
                preset(`Preset ${index}`, { historyQuery: `query-${index}` }),
            );
        }

        presets = upsertHistoryFilterPreset(
            presets,
            preset('  Preset 2  ', { historyQuery: 'replacement' }),
        );
        expect(presets).toHaveLength(12);
        expect(presets.at(-1)).toEqual(preset('Preset 2', {
            historyQuery: 'replacement',
        }));

        presets = upsertHistoryFilterPreset(
            presets,
            preset('Preset 13', { historyQuery: 'query-13' }),
        );
        expect(presets.map(entry => entry.name)).toEqual([
            'Preset 3',
            'Preset 4',
            'Preset 5',
            'Preset 6',
            'Preset 7',
            'Preset 8',
            'Preset 9',
            'Preset 10',
            'Preset 11',
            'Preset 12',
            'Preset 2',
            'Preset 13',
        ]);
        expect(removeHistoryFilterPreset(presets, '  Preset 2  ').map(entry => entry.name))
            .not.toContain('Preset 2');
    });
});

describe('Recipe Console History filter storage', () => {
    it('uses one versioned key and a deterministic exact-whitelist envelope', () => {
        expect(HISTORY_FILTER_PRESET_STORAGE_KEY).toBe(
            'rallar-black-box.ui.recipe-console.history-filter-presets.v1',
        );
        const serialized = serializeHistoryFilterPresets([
            preset('Failed ACKs', {
                historyQuery: 'ack',
                historyGroup: 'bb-group',
                historyRecipeId: 'health-only',
                historyProfile: 'smoke',
                failureCategory: 'readiness',
                status: 'failed',
                from: 100,
                to: 900,
            }),
        ]);

        expect(serialized).toBe(JSON.stringify({
            version: 1,
            presets: [{
                name: 'Failed ACKs',
                filters: {
                    historyQuery: 'ack',
                    historyGroup: 'bb-group',
                    historyRecipeId: 'health-only',
                    historyProfile: 'smoke',
                    failureCategory: 'readiness',
                    status: 'failed',
                    from: 100,
                    to: 900,
                },
            }],
        }));
        expect(deserializeHistoryFilterPresets(serialized)).toEqual({
            status: 'ready',
            presets: [preset('Failed ACKs', {
                historyQuery: 'ack',
                historyGroup: 'bb-group',
                historyRecipeId: 'health-only',
                historyProfile: 'smoke',
                failureCategory: 'readiness',
                status: 'failed',
                from: 100,
                to: 900,
            })],
        });
    });

    it('drops invalid entries atomically while preserving valid siblings', () => {
        const parsed = parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: [
                preset('First', { historyQuery: 'first' }),
                {
                    name: 'Leaky',
                    filters: {
                        historyQuery: 'leaky',
                        controlToken: 'secret-token',
                    },
                },
                preset('Bad status', {
                    status: 'not-a-state' as HistoryFilterPreset['filters']['status'],
                }),
                preset('Bad range', { from: 20, to: 10 }),
                preset('Last', { historyRecipeId: 'last-recipe' }),
            ],
        });

        expect(parsed).toEqual({
            status: 'ready',
            presets: [
                preset('First', { historyQuery: 'first' }),
                preset('Last', { historyRecipeId: 'last-recipe' }),
            ],
        });
    });

    it('enforces exact parse boundaries for query and other free-text filters', () => {
        const parsed = parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: [
                preset('Exact boundaries', {
                    historyQuery: 'q'.repeat(HISTORY_FILTER_PRESET_LIMITS.query),
                    historyGroup: 'g'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
                    historyRecipeId: 'r'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
                    historyProfile: 'p'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
                }),
                preset('Query over', {
                    historyQuery: 'q'.repeat(HISTORY_FILTER_PRESET_LIMITS.query + 1),
                }),
                preset('Group over', {
                    historyGroup: 'g'.repeat(HISTORY_FILTER_PRESET_LIMITS.string + 1),
                }),
            ],
        });

        expect(parsed.presets).toEqual([
            preset('Exact boundaries', {
                historyQuery: 'q'.repeat(HISTORY_FILTER_PRESET_LIMITS.query),
                historyGroup: 'g'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
                historyRecipeId: 'r'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
                historyProfile: 'p'.repeat(HISTORY_FILTER_PRESET_LIMITS.string),
            }),
        ]);
    });

    it('rejects malformed envelopes and preserves a future version as unsupported', () => {
        expect(deserializeHistoryFilterPresets('{')).toEqual({
            status: 'invalid',
            presets: [],
        });
        expect(parseHistoryFilterPresetEnvelope({ version: 1, presets: {} })).toEqual({
            status: 'invalid',
            presets: [],
        });
        expect(parseHistoryFilterPresetEnvelope({ version: 2, presets: [] })).toEqual({
            status: 'unsupported',
            presets: [],
        });
        expect(parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: [],
            token: 'secret',
        })).toEqual({
            status: 'invalid',
            presets: [],
        });
    });

    it('rejects a serialized value above the defensive raw-input budget', () => {
        expect(deserializeHistoryFilterPresets(
            ' '.repeat(HISTORY_FILTER_PRESET_MAX_SERIALIZED_LENGTH + 1),
        )).toEqual({
            status: 'invalid',
            presets: [],
        });
    });

    it('rejects prototype-shaped and accessor entries without invoking getters', () => {
        let getterCalls = 0;
        const accessor = { name: 'Accessor' } as Record<string, unknown>;
        Object.defineProperty(accessor, 'filters', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return {};
            },
        });
        const inherited = Object.create({ controlToken: 'prototype-secret' }) as
            Record<string, unknown>;
        inherited.name = 'Inherited';
        inherited.filters = {};

        const parsed = parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: [
                preset('Safe'),
                accessor,
                inherited,
                JSON.parse('{"name":"Proto key","filters":{"__proto__":{"token":"secret"}}}') as unknown,
            ],
        });

        expect(getterCalls).toBe(0);
        expect(parsed).toEqual({
            status: 'ready',
            presets: [preset('Safe')],
        });
    });

    it('deduplicates by the newest occurrence before keeping the newest twelve', () => {
        const entries = Array.from({ length: 13 }, (_, index) =>
            preset(`Preset ${index + 1}`, { historyQuery: `old-${index + 1}` }));
        entries.push(preset(' Preset 2 ', { historyQuery: 'newest-two' }));

        const parsed = parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: entries,
        });

        expect(parsed.presets).toHaveLength(12);
        expect(parsed.presets.map(entry => entry.name)).toEqual([
            'Preset 3',
            'Preset 4',
            'Preset 5',
            'Preset 6',
            'Preset 7',
            'Preset 8',
            'Preset 9',
            'Preset 10',
            'Preset 11',
            'Preset 12',
            'Preset 13',
            'Preset 2',
        ]);
        expect(parsed.presets.at(-1)?.filters.historyQuery).toBe('newest-two');
    });

    it('bounds direct untrusted arrays before validating dense entries', () => {
        const atLimit = Array.from(
            { length: HISTORY_FILTER_PRESET_MAX_INPUT_COUNT },
            (_, index) => preset(`Preset ${index}`, { historyQuery: String(index) }),
        );
        expect(parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: atLimit,
        }).presets).toHaveLength(HISTORY_FILTER_PRESET_LIMITS.count);
        expect(parseHistoryFilterPresetEnvelope({
            version: 1,
            presets: [...atLimit, preset('One too many')],
        })).toEqual({
            status: 'invalid',
            presets: [],
        });
    });

    it('treats disabled and throwing storage operations as nonfatal', () => {
        expect(readHistoryFilterPresets(undefined)).toEqual({
            status: 'unavailable',
            presets: [],
        });
        expect(writeHistoryFilterPresets(undefined, [preset('No storage')])).toBe(false);

        const storage = new MemoryStorage();
        storage.getError = new Error('read denied');
        expect(readHistoryFilterPresets(storage)).toEqual({
            status: 'unavailable',
            presets: [],
        });
        storage.getError = undefined;
        storage.setError = new Error('quota');
        expect(writeHistoryFilterPresets(storage, [preset('Quota')])).toBe(false);
        storage.setError = undefined;
        storage.removeError = new Error('remove denied');
        expect(writeHistoryFilterPresets(storage, [])).toBe(false);
    });

    it('removes the storage key instead of writing an empty envelope', () => {
        const storage = new MemoryStorage();
        storage.values.set(HISTORY_FILTER_PRESET_STORAGE_KEY, 'existing');

        expect(writeHistoryFilterPresets(storage, [])).toBe(true);
        expect(storage.removeCalls).toBe(1);
        expect(storage.setCalls).toBe(0);
        expect(storage.values.has(HISTORY_FILTER_PRESET_STORAGE_KEY)).toBe(false);
    });
});

describe('useHistoryFilterPresets', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;
    let controller: HistoryFilterPresetController | undefined;
    let browserStorage: MemoryStorage;

    beforeEach(() => {
        browserStorage = new MemoryStorage();
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: browserStorage,
        });
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        controller = undefined;
        container.remove();
    });

    it('saves the latest committed URL filters and never receives transient draft fields', async () => {
        const storage = new MemoryStorage();
        let committed = state({
            historyQuery: 'first committed',
            historyRecipeId: 'first-recipe',
            recipeId: 'operational-secret',
        });

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: committed,
                storage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        committed = state({
            historyQuery: 'latest committed',
            historyRecipeId: 'latest-recipe',
            recipeId: 'new-operational-secret',
        });
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('Latest'));

        const raw = storage.getItem(HISTORY_FILTER_PRESET_STORAGE_KEY) ?? '';
        expect(raw).toContain('latest committed');
        expect(raw).toContain('latest-recipe');
        expect(raw).not.toContain('first committed');
        expect(raw).not.toContain('operational-secret');
        expect(controller?.presets).toEqual([
            preset('Latest', {
                historyQuery: 'latest committed',
                historyRecipeId: 'latest-recipe',
            }),
        ]);
    });

    it('keeps an explicit committed URL authoritative over loaded presets until apply', async () => {
        const storage = new MemoryStorage();
        storage.values.set(
            HISTORY_FILTER_PRESET_STORAGE_KEY,
            serializeHistoryFilterPresets([
                preset('Saved', { historyQuery: 'saved query' }),
            ]),
        );
        const committed = state({ historyQuery: 'explicit URL query' });

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: committed,
                storage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('URL remains authoritative'));

        expect(controller?.presets).toEqual([
            preset('Saved', { historyQuery: 'saved query' }),
            preset('URL remains authoritative', {
                historyQuery: 'explicit URL query',
            }),
        ]);
    });

    it('keeps durable state unchanged when save or removal fails', async () => {
        const storage = new MemoryStorage();

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: state({ historyQuery: 'committed' }),
                storage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        storage.setError = new Error('quota');
        await act(async () => controller?.save('Not durable'));
        expect(controller?.presets).toEqual([]);
        expect(controller?.status).toBe('write-failed');

        storage.setError = undefined;
        await act(async () => controller?.save('Durable'));
        expect(controller?.presets).toEqual([
            preset('Durable', { historyQuery: 'committed' }),
        ]);
        storage.removeError = new Error('remove denied');
        await act(async () => controller?.remove('Durable'));
        expect(controller?.presets).toEqual([
            preset('Durable', { historyQuery: 'committed' }),
        ]);
        expect(controller?.status).toBe('write-failed');
    });

    it('keeps storage writes outside replayable React state updaters', async () => {
        const storage = new MemoryStorage();

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: state({ historyQuery: 'strict committed' }),
                storage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(
            createElement(StrictMode, null, createElement(Harness)),
        ));
        await act(async () => controller?.save('Strict save'));

        expect(storage.setCalls).toBe(1);
        expect(controller?.presets).toEqual([
            preset('Strict save', { historyQuery: 'strict committed' }),
        ]);
    });

    it('reloads a replaced storage port before allowing writes', async () => {
        const firstStorage = new MemoryStorage();
        const futureStorage = new MemoryStorage();
        const future = JSON.stringify({ version: 2, presets: [] });
        futureStorage.values.set(HISTORY_FILTER_PRESET_STORAGE_KEY, future);
        let currentStorage: HistoryFilterStorage = firstStorage;

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: state({ historyQuery: 'committed' }),
                storage: currentStorage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        currentStorage = futureStorage;
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('Blocked after replacement'));

        expect(controller?.status).toBe('unsupported');
        expect(futureStorage.getItem(HISTORY_FILTER_PRESET_STORAGE_KEY)).toBe(future);
        expect(futureStorage.setCalls).toBe(0);
    });

    it('does not overwrite a future-version value', async () => {
        const storage = new MemoryStorage();
        const future = JSON.stringify({ version: 2, presets: [] });
        storage.values.set(HISTORY_FILTER_PRESET_STORAGE_KEY, future);

        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: state({ historyQuery: 'committed' }),
                storage,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('Blocked downgrade'));

        expect(controller?.status).toBe('unsupported');
        expect(storage.getItem(HISTORY_FILTER_PRESET_STORAGE_KEY)).toBe(future);
        expect(storage.setCalls).toBe(0);
    });

    it('treats an explicitly disabled storage port as unavailable', async () => {
        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: BASE_STATE,
                storage: null,
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('No storage'));

        expect(controller).toMatchObject({
            presets: [],
            status: 'unavailable',
        });
    });

    it('resolves browser localStorage only when no injected port is supplied', async () => {
        function Harness() {
            controller = useHistoryFilterPresets({
                committedUrlState: state({ historyQuery: 'browser committed' }),
            });
            return null;
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => controller?.save('Browser'));

        expect(browserStorage.getItem(HISTORY_FILTER_PRESET_STORAGE_KEY))
            .toContain('browser committed');
    });
});

describe('History filter persistence ownership', () => {
    it('keeps browser localStorage access in the hook and out of pure or eager owners', () => {
        const source = (relativePath: string): string => readFileSync(
            resolve(
                process.cwd(),
                'apps/rallar-black-box/src/recipe-console',
                relativePath,
            ),
            'utf8',
        );

        const references = (relativePath: string): readonly string[] => {
            const text = source(relativePath);
            const file = ts.createSourceFile(
                relativePath,
                text,
                ts.ScriptTarget.Latest,
                true,
                relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            const matches: string[] = [];
            const visit = (node: ts.Node): void => {
                if (ts.isIdentifier(node) && node.text === 'localStorage') {
                    matches.push(node.getText(file));
                }
                ts.forEachChild(node, visit);
            };
            visit(file);
            return matches;
        };
        expect(references('history/use-history-filter-presets.ts')).toEqual([
            'localStorage',
        ]);
        const historyFiles = readdirSync(resolve(
            process.cwd(),
            'apps/rallar-black-box/src/recipe-console/history',
        )).filter(name => /\.(?:ts|tsx)$/.test(name))
            .map(name => `history/${name}`)
            .filter(name => name !== 'history/use-history-filter-presets.ts');
        for (const relativePath of [
            ...historyFiles,
            'tune/TuneWorkspace.tsx',
            'control/ControlConnectionProvider.tsx',
            'app/RecipeConsoleWorkspace.tsx',
        ]) {
            expect(references(relativePath), relativePath).toEqual([]);
        }
        expect(source('history/history-filter-storage.ts')).not.toMatch(
            /names\.includes\s*\(/,
        );
    });
});
