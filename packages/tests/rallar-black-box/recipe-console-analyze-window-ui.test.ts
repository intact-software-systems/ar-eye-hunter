// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAnalyzeEvidenceWindowModel } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-evidence-window-model.ts';
import type { AnalyzeEvidenceWindowProjection } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import { AnalyzeEvidenceSearch } from '../../../apps/rallar-black-box/src/recipe-console/analyze/AnalyzeEvidenceSearch.tsx';
import type { AnalyzeWorkspaceController } from '../../../apps/rallar-black-box/src/recipe-console/analyze/use-analyze-workspace.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console Analyze evidence cursor window', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('adapts exact one-based worker ranges and cursor boundaries', () => {
        const middle = deriveAnalyzeEvidenceWindowModel(
            windowProjection({ rangeStart: 65, rangeEnd: 128 }),
            'artifact-7:query-a'
        );
        expect(middle).toEqual({
            fingerprint: 'artifact-7:query-a',
            total: 150,
            windowSize: 64,
            startIndex: 64,
            endIndexExclusive: 128,
            displayStart: 65,
            displayEnd: 128,
            canPrevious: true,
            canNext: true
        });

        const last = deriveAnalyzeEvidenceWindowModel(
            windowProjection({
                rangeStart: 129,
                rangeEnd: 150,
                nextCursor: undefined
            }),
            'artifact-7:query-a'
        );
        expect(last).toMatchObject({
            displayStart: 129,
            displayEnd: 150,
            canPrevious: true,
            canNext: false
        });
    });

    it('distinguishes not-started, pending, and unavailable search truth before a current window', async () => {
        await render(controller());
        expect(container.querySelector('[data-analyze-search-status]')?.textContent)
            .toBe('Search not started');
        expect(container.querySelector('[data-analyze-evidence-not-started]')?.textContent)
            .toBe('Evidence search has not started.');
        expect(container.querySelector('[data-analyze-no-evidence]')).toBeNull();

        await render(controller({ evidenceWindowPending: true }));
        expect(container.querySelector('[data-analyze-search-status]')?.textContent)
            .toBe('Search pending');
        expect(container.querySelector('[data-analyze-evidence-stale]')?.textContent)
            .toContain('Searching the active artifact and filters');
        expect(container.querySelector('[data-analyze-no-evidence]')).toBeNull();

        await render(controller({
            evidenceWindowError: 'The evidence search request failed. Try again.'
        }));
        expect(container.querySelector('[data-analyze-search-status]')?.textContent)
            .toBe('Search unavailable');
        expect(container.querySelector('[data-analyze-evidence-unavailable]')?.textContent)
            .toContain('Current query evidence is unavailable');
        expect(container.querySelector('[data-analyze-no-evidence]')).toBeNull();
    });

    it('renders one native bounded list with exact truth and bidi-isolated identifiers', async () => {
        const exactAgent = 'agent-‮gnul-界';
        const exactRecipe = 'מתכון-界';
        const exactCommand = 'command-⁦exact⁩-🧪';
        await render(controller({
            evidenceWindow: windowProjection({
                entries: Array.from({ length: 64 }, (_, index) =>
                    entry(index, {
                        ...(index === 0
                            ? {
                                agentId: exactAgent,
                                recipeId: exactRecipe,
                                commandId: exactCommand
                            }
                            : {})
                    })),
                indexOmittedEntries: 12,
                rangeStart: 65,
                rangeEnd: 128
            }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a'
        }));

        const list = container.querySelector('ol#analyze-evidence-results');
        expect(list).not.toBeNull();
        expect(list?.querySelectorAll(':scope > li')).toHaveLength(64);
        expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(64);
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 65–128 of 150 retained matches.');
        expect(container.querySelector('[data-analyze-producer-compaction]')?.textContent)
            .toContain('Unavailable');
        expect(container.querySelector('[data-analyze-index-omission]')?.textContent)
            .toContain('12 source entries omitted before search and not searchable');
        expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
            .toContain('150 retained matches');
        expect(container.querySelector('[data-analyze-render-window-truth]')?.textContent)
            .toContain('86 outside this render window and browseable');
        expect([...container.querySelectorAll('bdi[data-exact-identifier]')].map(
            (node) => ({ dir: node.getAttribute('dir'), text: node.textContent })
        )).toEqual([
            { dir: 'ltr', text: exactAgent },
            { dir: 'ltr', text: exactRecipe },
            { dir: 'ltr', text: exactCommand }
        ]);
    });

    it('keeps pending controls mounted, blocks repeat cursor requests, and reports failure', async () => {
        const requestWindow = vi.fn();
        const retryEvidenceSearch = vi.fn();
        await render(controller({
            evidenceWindow: windowProjection({ rangeStart: 65, rangeEnd: 128 }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a',
            evidenceWindowPending: true,
            requestWindow,
            retryEvidenceSearch
        }));

        const buttons = [...container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Evidence results window"] button'
        )];
        expect(buttons.every((button) => button.getAttribute('aria-disabled') === 'true'))
            .toBe(true);
        await act(async () => buttons[0]?.click());
        await act(async () => buttons[1]?.click());
        expect(requestWindow).not.toHaveBeenCalled();

        await render(controller({
            evidenceWindow: windowProjection({ rangeStart: 65, rangeEnd: 128 }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a',
            evidenceWindowError: 'The evidence window request failed. Try again.',
            requestWindow,
            retryEvidenceSearch
        }));
        expect(container.querySelector('[data-analyze-window-error]')?.textContent)
            .toContain('The evidence window request failed. Try again.');
        const retry = [...container.querySelectorAll('button')].find(
            (button) => button.textContent === 'Retry evidence search'
        );
        await act(async () => retry?.click());
        expect(retryEvidenceSearch).toHaveBeenCalledOnce();
    });

    it('unmounts stale query rows and recovers row focus after cursor traversal', async () => {
        const first = controller({
            evidenceWindow: windowProjection({
                entries: Array.from({ length: 64 }, (_, index) => entry(index)),
                rangeStart: 1,
                rangeEnd: 64,
                previousCursor: undefined
            }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a'
        });
        await render(first);
        const focusedRow = container.querySelector<HTMLButtonElement>(
            '[data-evidence-id="evidence-0"]'
        );
        focusedRow?.focus();
        expect(document.activeElement).toBe(focusedRow);

        await render(controller({
            evidenceWindow: windowProjection({
                entries: Array.from({ length: 64 }, (_, index) => entry(index + 64)),
                rangeStart: 65,
                rangeEnd: 128
            }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a'
        }));
        expect(document.activeElement).toBe(
            container.querySelector('[role="status"]')
        );

        await render(controller({
            evidenceWindow: windowProjection({
                entries: [entry(64)],
                rangeStart: 65,
                rangeEnd: 65
            }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-b',
            evidenceWindowPending: true
        }));
        expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(0);
        expect(container.querySelector('ol#analyze-evidence-results')).not.toBeNull();
        expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
            .toContain('Pending current query');
        expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
            .not.toContain('0 retained matches');
        expect(container.querySelector('[data-analyze-evidence-stale]')?.textContent)
            .toContain('Searching the active artifact and filters');

        await render(controller({
            evidenceWindow: first.evidenceWindow,
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-b',
            evidenceWindowError: 'The evidence search request failed. Try again.'
        }));
        expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(0);
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Current query range is unavailable.');
        expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
            .toContain('Unavailable for current query');
        expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
            .not.toContain('Pending current query');
        expect(container.querySelector('[data-analyze-evidence-unavailable]')?.textContent)
            .toContain('prior query rows are not mounted');
    });

    it('uses the stable range status as inspector restore focus when URL metadata invalidates the row', async () => {
        const updateFilters = vi.fn();
        let restoreTarget: HTMLElement | undefined;
        const exactAgent = 'agent-‮focus-界';
        const exactRecipe = 'מתכון-focus';
        const exactCommand = 'command-⁦focus⁩';
        const current = controller({
            evidenceWindow: windowProjection({
                entries: [entry(0, {
                    agentId: exactAgent,
                    recipeId: exactRecipe,
                    commandId: exactCommand
                })],
                rangeStart: 1,
                rangeEnd: 1
            }),
            evidenceWindowFingerprint: 'artifact-7:query-a',
            queryFingerprint: 'artifact-7:query-a',
            updateFilters
        });
        await render(current, {
            onInspect: (target) => {
                restoreTarget = target;
            }
        });

        const result = container.querySelector<HTMLButtonElement>(
            '[data-evidence-result]'
        );
        result?.focus();
        await act(async () => result?.click());
        expect(updateFilters).toHaveBeenCalledWith({
            agentId: exactAgent,
            recipeId: exactRecipe,
            commandId: exactCommand
        });
        expect(restoreTarget).toBe(container.querySelector('[role="status"]'));

        await render(
            controller({
                ...current,
                evidenceWindowFingerprint: 'artifact-7:query-a',
                queryFingerprint: 'artifact-7:query-b',
                evidenceWindowPending: true
            }),
            {
                onInspect: (target) => {
                    restoreTarget = target;
                },
                urlState: {
                    v: 1,
                    experience: 'recipe-console',
                    view: 'analyze',
                    agentId: exactAgent,
                    recipeId: exactRecipe,
                    commandId: exactCommand
                }
            }
        );
        expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(0);
        expect(restoreTarget?.isConnected).toBe(true);
        restoreTarget?.focus();
        expect(document.activeElement).toBe(restoreTarget);
    });

    async function render(
        value: AnalyzeWorkspaceController,
        options: Readonly<{
            onInspect?(target: HTMLElement): void;
            urlState?: Parameters<typeof AnalyzeEvidenceSearch>[0]['urlState'];
        }> = {}
    ): Promise<void> {
        await act(async () =>
            root.render(createElement(AnalyzeEvidenceSearch, {
                controller: value,
                onInspect: options.onInspect,
                urlState: options.urlState ?? {
                    v: 1,
                    experience: 'recipe-console',
                    view: 'analyze'
                }
            }))
        );
    }
});

function controller(overrides: Partial<AnalyzeWorkspaceController> = {}) {
    return {
        model: { distributedRunId: 'run-a' },
        searchResult: undefined,
        evidenceWindow: undefined,
        evidenceWindowFingerprint: undefined,
        queryFingerprint: 'artifact-7:query-a',
        evidenceWindowPending: false,
        evidenceWindowError: undefined,
        selectedEvidence: undefined,
        updateFilters: vi.fn(),
        clearFilters: vi.fn(),
        selectEvidence: vi.fn(),
        requestWindow: vi.fn(),
        retryEvidenceSearch: vi.fn(),
        ...overrides
    } as unknown as AnalyzeWorkspaceController;
}

function entry(
    index: number,
    fields: Readonly<Record<string, string>> = {}
) {
    return {
        id: `evidence-${index}`,
        kind: 'event' as const,
        sourceFile: 'events.jsonl',
        summary: `Evidence ${index + 1}`,
        payloadSummary: '{}',
        ...fields
    };
}

function windowProjection(
    input: Readonly<{
        entries?: AnalyzeEvidenceWindowProjection['entries'];
        rangeStart: number;
        rangeEnd: number;
        previousCursor?: string;
        nextCursor?: string;
        indexOmittedEntries?: number;
    }>
): AnalyzeEvidenceWindowProjection {
    const entries = input.entries ?? Array.from(
        { length: Math.max(0, input.rangeEnd - input.rangeStart + 1) },
        (_, index) => entry(input.rangeStart - 1 + index)
    );
    return {
        entries,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        ...(input.previousCursor === undefined && input.rangeStart <= 1
            ? {}
            : { previousCursor: input.previousCursor ?? 'previous-cursor' }),
        ...(input.nextCursor === undefined && input.rangeEnd >= 150
            ? {}
            : { nextCursor: input.nextCursor ?? 'next-cursor' }),
        counts: {
            totalEntries: 162,
            indexedEntries: 150,
            indexOmittedEntries: input.indexOmittedEntries ?? 0,
            retainedMatches: 150,
            queryExcludedEntries: 0,
            renderedMatches: entries.length,
            renderOmittedMatches: 150 - entries.length
        },
        totalMatchesIsComplete: (input.indexOmittedEntries ?? 0) === 0,
        windowSize: 64
    };
}
