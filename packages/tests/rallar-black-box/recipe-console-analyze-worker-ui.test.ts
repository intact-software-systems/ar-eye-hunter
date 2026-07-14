// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyzeWorkspace } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/AnalyzeWorkspace.tsx';
import { AnalyzeEvidenceSearch } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/AnalyzeEvidenceSearch.tsx';
import type { AnalyzeWorkspaceController } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/use-analyze-workspace.ts';
import { createAnalyzeWorkerWorkspaceCallbacks } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-workspace-callbacks.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console Analyze worker UI telemetry', () => {
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

    it('renders numeric worker cardinality and a committed pending-paint marker', async () => {
        const controller = {
            model: undefined,
            status: 'pending',
            error: undefined,
            busyAction: 'import-local',
            pendingPaintGeneration: 7,
            operationGeneration: 7,
            telemetry: {
                durationMs: 12,
                parseDurationMs: 4,
                sourceFileCount: 8,
                sourceBytes: 1024,
                pipelinePassCount: 1,
                sourceCollectionPassCount: 1,
                sourceFileVisitCount: 8,
                documentParseCount: 6,
                jsonlFilePassCount: 2,
                jsonlRowParseCount: 15_000,
                totalEntryCount: 15_003,
                retainedEntryCount: 15_003,
                indexOmittedEntryCount: 0,
                matchedEntryCount: 321,
                projectedEntryCount: 64,
            },
            evidenceWindow: {
                entries: Array.from({ length: 64 }, () => ({})),
            },
            selectedEvidence: undefined,
            controlRunOptions: [],
            distributedRunOptions: [],
            canLoad: false,
            loadReason: 'Busy',
            importFiles: vi.fn(),
            loadControlArtifact: vi.fn(),
            exportArtifact: vi.fn(),
            clearArtifact: vi.fn(),
            selectEvidence: vi.fn(),
            requestWindow: vi.fn(),
            selectControlRun: vi.fn(),
            selectDistributedRun: vi.fn(),
            updateFilters: vi.fn(),
            clearFilters: vi.fn(),
        } as unknown as AnalyzeWorkspaceController;

        await act(async () => root.render(createElement(AnalyzeWorkspace, {
            controller,
            urlState: { v: 1, experience: 'recipe-console', view: 'analyze' },
            onInspect: vi.fn(),
            onInspectorChange: vi.fn(),
            onSelectionLabelChange: vi.fn(),
        })));

        const workspace = container.querySelector<HTMLElement>('[data-analyze-workspace]');
        expect(workspace?.dataset).toMatchObject({
            analyzeSourceCount: '8',
            analyzeTotalEntryCount: '15003',
            analyzeIndexCount: '15003',
            analyzeIndexOmittedCount: '0',
            analyzeMatchCount: '321',
            analyzeMountedCount: '0',
            analyzeOperationGeneration: '7',
            analyzePendingPainted: 'true',
        });
        expect(Number(workspace?.dataset.analyzeRenderCount)).toBeGreaterThan(0);
    });

    it('rejects over-budget UTF-8 filters visibly without changing prior evidence', async () => {
        const updateFilters = vi.fn();
        const clearFilters = vi.fn();
        const controller = {
            model: {},
            queryFingerprint: 'artifact-1:query-a',
            evidenceWindowFingerprint: 'artifact-1:query-a',
            evidenceWindowPending: false,
            evidenceWindow: {
                entries: [{
                    id: 'evidence-1',
                    kind: 'failure',
                    sourceFile: 'failures.json',
                    summary: 'Prior failure evidence',
                    payloadSummary: '{}',
                }],
                rangeStart: 1,
                rangeEnd: 1,
                counts: {
                    totalEntries: 1,
                    indexedEntries: 1,
                    indexOmittedEntries: 0,
                    retainedMatches: 1,
                    queryExcludedEntries: 0,
                    renderedMatches: 1,
                    renderOmittedMatches: 0,
                },
                totalMatchesIsComplete: true,
                windowSize: 64,
            },
            searchResult: {
                entries: [{
                    id: 'evidence-1',
                    kind: 'failure',
                    sourceFile: 'failures.json',
                    summary: 'Prior failure evidence',
                    payloadSummary: '{}',
                }],
                totalMatches: 1,
                omittedMatchCount: 0,
                upstreamOmittedEntryCount: 0,
                totalMatchesIsComplete: true,
                limit: 64,
            },
            selectedEvidence: undefined,
            updateFilters,
            clearFilters,
            selectEvidence: vi.fn(),
        } as unknown as AnalyzeWorkspaceController;

        await act(async () => root.render(createElement(AnalyzeEvidenceSearch, {
            controller,
            urlState: { v: 1, experience: 'recipe-console', view: 'analyze' },
        })));

        const query = container.querySelector<HTMLInputElement>(
            'input[name="query"]',
        )!;
        const form = container.querySelector<HTMLFormElement>('form')!;
        query.value = '界'.repeat(2_000);
        await act(async () => {
            form.dispatchEvent(new Event('submit', {
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(updateFilters).not.toHaveBeenCalled();
        expect(container.querySelector('[data-analyze-search-error]')?.textContent)
            .toContain('Search evidence exceeds the 4096-byte limit');
        expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(1);

        const clear = [...container.querySelectorAll('button')].find(
            button => button.textContent === 'Clear filters',
        )!;
        await act(async () => clear.click());
        expect(clearFilters).toHaveBeenCalledOnce();
        expect(container.querySelector<HTMLInputElement>('input[name="query"]')?.value)
            .toBe('');
        expect(container.querySelector('[data-analyze-search-error]')).toBeNull();

        const boundedQuery = '界'.repeat(1_300);
        const resetQuery = container.querySelector<HTMLInputElement>(
            'input[name="query"]',
        )!;
        resetQuery.value = boundedQuery;
        await act(async () => {
            container.querySelector<HTMLFormElement>('form')?.dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });
        expect(updateFilters).toHaveBeenLastCalledWith({
            historyQuery: boundedQuery,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
    });

    it('does not mount fingerprintless initial rows for a URL-filtered import',
        async () => {
            const controller = {
                model: {},
                queryFingerprint: 'artifact-1:filtered-query',
                evidenceWindowFingerprint: undefined,
                evidenceWindowPending: true,
                evidenceWindow: {
                    entries: [{
                        id: 'unfiltered-initial-row',
                        kind: 'event',
                        sourceFile: 'events.jsonl',
                        summary: 'Must not flash for filtered URL',
                        payloadSummary: '{}',
                    }],
                    rangeStart: 1,
                    rangeEnd: 1,
                    counts: {
                        totalEntries: 1,
                        indexedEntries: 1,
                        indexOmittedEntries: 0,
                        retainedMatches: 1,
                        queryExcludedEntries: 0,
                        renderedMatches: 1,
                        renderOmittedMatches: 0,
                    },
                    totalMatchesIsComplete: true,
                    windowSize: 64,
                },
                searchResult: undefined,
                selectedEvidence: undefined,
                updateFilters: vi.fn(),
                clearFilters: vi.fn(),
                selectEvidence: vi.fn(),
                requestWindow: vi.fn(),
                retryEvidenceSearch: vi.fn(),
            } as unknown as AnalyzeWorkspaceController;

            await act(async () => root.render(createElement(AnalyzeEvidenceSearch, {
                controller,
                urlState: {
                    v: 1,
                    experience: 'recipe-console',
                    view: 'analyze',
                    historyQuery: 'needle',
                },
            })));

            expect(container.querySelectorAll('[data-evidence-result]')).toHaveLength(0);
            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Current query range is pending. Updating…');
            expect(container.querySelector('[data-analyze-matching-truth]')?.textContent)
                .toContain('Pending current query');
        });

    it('scopes request timeout failure without declaring the accepted worker unavailable',
        () => {
            const fail = vi.fn();
            const setWorkerUnavailable = vi.fn();
            const callbacks = createAnalyzeWorkerWorkspaceCallbacks({
                pendingRef: { current: undefined },
                validationErrorRef: { current: undefined },
                pendingIdentityPatchRef: { current: undefined },
                setState: vi.fn(),
                evidence: { fail } as never,
                setSelectedEvidence: vi.fn(),
                setTuneFacade: vi.fn(),
                setTelemetry: vi.fn(),
                setWorkerUnavailable,
                setPendingPaintGeneration: vi.fn(),
            });

            callbacks.onUnavailable?.('timeout', 'accepted-request', {
                kind: 'search',
                requestId: 47,
            });

            expect(fail).toHaveBeenCalledWith('search', 47);
            expect(setWorkerUnavailable).not.toHaveBeenCalled();
        });
});
