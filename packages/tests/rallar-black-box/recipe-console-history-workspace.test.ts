// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryWorkspace.tsx';
import { rememberControlResponseDocument } from
    '../../../apps/rallar-black-box/src/control-response-document.ts';
import { createControlSnapshotRevisionSession } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-snapshot-revision.ts';
import type { RecipeConsoleControlQueryProvenance } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import type { ControlServerSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { createRecipeConsoleControlScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const urlState: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
    historyQuery: 'ack failure',
    historyGroup: 'group-a',
    historyRecipeId: 'rtc-stream',
    historyProfile: 'smoke',
    failureCategory: 'readiness',
    status: 'failed',
};

function retentionProps() {
    return {
        refreshAfterCurrent: vi.fn(async () => {}),
        replace: vi.fn(),
    };
}

function query(input: Readonly<{
    status: ControlQuerySnapshot<ControlServerSnapshot>['status'];
    snapshot?: ControlServerSnapshot;
    source?: RecipeConsoleControlQueryProvenance['distributedRunsSource'];
    completeness?: 'complete' | 'partial';
}>): ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance> {
    return {
        status: input.status,
        reachability: input.status === 'offline' ? 'unreachable' : 'reachable',
        authorization: 'ready',
        snapshot: input.snapshot,
        completeness: input.completeness,
        provenance: input.source
            ? { distributedRunsSource: input.source }
            : undefined,
        receivedAtEpochMs: input.snapshot ? 1_000 : undefined,
        isRefreshing: false,
        ...(input.status === 'offline'
            ? { lastError: { kind: 'network' as const, message: 'connection refused' } }
            : {}),
    };
}

describe('HistoryWorkspace', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;
    let storageValues: Map<string, string>;

    beforeEach(() => {
        storageValues = new Map();
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => storageValues.get(key) ?? null,
                setItem: (key: string, value: string) => storageValues.set(key, value),
                removeItem: (key: string) => storageValues.delete(key),
            },
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    it('shows committed filters, exact provenance, copy, legacy handoff, and empty truth', async () => {
        const onCopyLink = vi.fn();
        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink,
            query: query({
                status: 'live',
                snapshot: { runs: [], distributedRuns: [] },
                source: 'root-snapshot',
                completeness: 'complete',
            }),
            urlState,
        })));

        expect(container.querySelector('[data-history-workspace]')).toBeTruthy();
        expect(container.textContent).toContain('Server run history');
        expect(container.textContent).toContain('Root snapshot · complete · current');
        expect(container.textContent).toContain('Text “ack failure”');
        expect(container.textContent).toContain('Group group-a');
        expect(container.textContent).toContain('Recipe rtc-stream');
        expect(container.textContent).toContain('No runs match these filters');
        expect(container.textContent).toContain('0 filtered · 0 rendered · 0 omitted');
        expect([...container.querySelectorAll('h3')].map(heading => heading.textContent))
            .toEqual(expect.arrayContaining([
                'Find a previous run',
                'History filter presets',
                'Run history',
            ]));

        const copy = [...container.querySelectorAll('button')].find(button =>
            button.textContent === 'Copy filtered link'
        );
        await act(async () => copy?.click());
        expect(onCopyLink).toHaveBeenCalledTimes(1);
        const legacy = [...container.querySelectorAll('a')].find(anchor =>
            anchor.textContent === 'Open legacy Runs'
        );
        expect(legacy?.getAttribute('href')).toMatch(
            /experience=legacy.*workspace=black-box-runner.*tab=runs/,
        );
    });

    it('keeps filters usable while distributed history is unavailable', async () => {
        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            query: query({ status: 'offline' }),
            urlState,
        })));

        expect(container.textContent).toContain('History unavailable');
        expect(container.textContent).toContain('connection refused');
        expect(container.querySelector('[data-history-filters]')).toBeTruthy();
        expect(container.querySelector('[role="region"][aria-label="Recipe run history"]'))
            .toBeNull();
    });

    it('distinguishes fallback, last-known, and partial source truth', async () => {
        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            query: query({
                status: 'live',
                snapshot: { runs: [], distributedRuns: [] },
                source: 'canonical-fallback',
                completeness: 'complete',
            }),
            urlState,
        })));
        expect(container.textContent).toContain(
            'Canonical fallback · complete · current',
        );

        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            query: query({
                status: 'stale',
                snapshot: { runs: [], distributedRuns: [] },
                source: 'root-snapshot',
                completeness: 'complete',
            }),
            urlState,
        })));
        expect(container.textContent).toContain(
            'Showing last-known server history while the root query recovers.',
        );

        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            query: query({
                status: 'partial',
                snapshot: { runs: [] },
                source: 'unavailable',
                completeness: 'partial',
            }),
            urlState,
        })));
        expect(container.textContent).toContain(
            'Source unavailable · unavailable · unavailable',
        );
        expect(container.textContent).toContain('History unavailable');
    });

    it('keeps a safe epoch outside the Date display range visible without crashing', async () => {
        await act(async () => root?.render(createElement(HistoryWorkspace, {
            ...retentionProps(),
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            query: query({
                status: 'live',
                snapshot: { runs: [], distributedRuns: [] },
                source: 'root-snapshot',
                completeness: 'complete',
            }),
            urlState: { ...urlState, from: Number.MAX_SAFE_INTEGER },
        })));

        expect(container.textContent).toContain(
            `From ${Number.MAX_SAFE_INTEGER} ms (outside display range)`,
        );
        expect((container.querySelector(
            'input[type="datetime-local"]',
        ) as HTMLInputElement | null)?.value).toBe('');
    });

    it('bounds 5,000 runs behind controls outside the table scroll',
        async () => {
            const fixture = createRecipeConsoleControlScaleFixture();
            await act(async () => root?.render(createElement(HistoryWorkspace, {
                ...retentionProps(),
                navigate: vi.fn(),
                onCopyLink: vi.fn(),
                query: query({
                    status: 'live',
                    snapshot: fixture.snapshot,
                    source: 'root-snapshot',
                    completeness: 'complete',
                }),
                urlState: { v: 1, experience: 'recipe-console', view: 'tune' },
            })));

            const controls = container.querySelector<HTMLElement>(
                '[data-history-window-controls]',
            );
            const scroll = container.querySelector<HTMLElement>(
                '[role="region"][aria-label="Recipe run history"]',
            );
            expect(controls).toBeTruthy();
            expect(scroll?.contains(controls)).toBe(false);
            expect(container.querySelectorAll('[data-history-row-key]')).toHaveLength(80);
            expect(container.querySelector('[data-history-window-outside]')?.textContent)
                .toBe('4,920 runs outside this render window and browseable.');
            const telemetry = container.querySelector<HTMLElement>(
                '[data-history-projected-rows]',
            );
            expect(telemetry?.dataset).toMatchObject({
                historyControlRunVisits: '5000',
                historyDistributedRunVisits: '5000',
                historyProjectedRows: '80',
                historyLabelProjections: '80',
                historyCatalogRunProjections: '80',
                historyActionProjections: '80',
                historyControlAgentVisits: '80',
            });

            const next = Array.from(
                container.querySelectorAll<HTMLButtonElement>('button'),
            ).find(button => button.textContent === 'Next');
            expect(next?.disabled).toBe(false);
            await act(async () => next?.click());

            const renderedKeys = Array.from(
                container.querySelectorAll<HTMLElement>('[data-history-row-key]'),
            ).map(row => row.dataset.historyRowKey);
            expect(renderedKeys).toHaveLength(80);
            expect(renderedKeys.at(0)).toBe('history-row:80');
            expect(renderedKeys.at(-1)).toBe('history-row:159');
            expect(container.querySelector(
                '[data-history-window-controls] [role="status"]',
            )?.textContent)
                .toBe('Showing 81–160 of 5,000 runs.');
            expect(container.querySelector('[data-history-window-outside]')?.textContent)
                .toBe('4,920 runs outside this render window and browseable.');
        });

    it('preserves an equal poll page, resets filters and source, and recovers focus',
        async () => {
            const fixture = createRecipeConsoleControlScaleFixture({ pairCount: 161 });
            const baseState: RecipeConsoleUrlState = {
                v: 1, experience: 'recipe-console', view: 'tune',
            };
            const renderHistory = async (
                snapshot: ControlServerSnapshot,
                state: RecipeConsoleUrlState,
                source: RecipeConsoleControlQueryProvenance['distributedRunsSource'] =
                    'root-snapshot',
            ) => act(async () => root?.render(createElement(HistoryWorkspace, {
                ...retentionProps(),
                navigate: vi.fn(),
                onCopyLink: vi.fn(),
                query: query({
                    status: 'live', snapshot, source, completeness: 'complete',
                }),
                urlState: state,
            })));
            const range = () => container.querySelector(
                '[data-history-window-controls] [role="status"]',
            )?.textContent;
            const next = () => [...container.querySelectorAll<HTMLButtonElement>(
                '[data-history-window-controls] button',
            )].find(button => button.textContent === 'Next');

            await renderHistory(fixture.snapshot, baseState);
            await act(async () => next()?.click());
            expect(range()).toBe('Showing 81–160 of 161 runs.');
            const retainedFocus = container.querySelector<HTMLButtonElement>(
                '[data-history-row-key="history-row:80"] button',
            );
            retainedFocus?.focus();

            await renderHistory(structuredClone(fixture.snapshot), {
                ...baseState,
                compareLeft: fixture.needles.distributedRunIds.first,
            });
            expect(range()).toBe('Showing 81–160 of 161 runs.');
            expect(document.activeElement).toBe(retainedFocus);

            const filteredState = { ...baseState, historyQuery: 'scale' };
            await renderHistory(fixture.snapshot, filteredState);
            expect(range()).toBe('Showing 1–80 of 161 runs.');
            expect(document.activeElement).toBe(container.querySelector(
                '[data-history-window-focus-anchor]',
            ));

            await act(async () => next()?.click());
            expect(range()).toBe('Showing 81–160 of 161 runs.');
            await renderHistory(
                fixture.snapshot,
                filteredState,
                'canonical-fallback',
            );
            expect(range()).toBe('Showing 1–80 of 161 runs.');

            await act(async () => next()?.click());
            const removedFocus = container.querySelector<HTMLButtonElement>(
                '[data-history-row-key="history-row:80"] button',
            );
            removedFocus?.focus();
            const belowBudget = createRecipeConsoleControlScaleFixture({
                pairCount: 50,
            });
            await renderHistory(
                belowBudget.snapshot,
                filteredState,
                'canonical-fallback',
            );
            expect(container.querySelector('[data-history-window-controls]')).toBeNull();
            expect(container.querySelectorAll('[data-history-row-key]')).toHaveLength(50);
            expect(document.activeElement).toBe(container.querySelector(
                '[data-history-window-focus-anchor]',
            ));
        });

    it('preserves an exact response revision and resets a changed document revision',
        async () => {
            const fixture = createRecipeConsoleControlScaleFixture({ pairCount: 161 });
            const same = structuredClone(fixture.snapshot);
            const changed = structuredClone(fixture.snapshot);
            const session = createControlSnapshotRevisionSession();
            for (const [snapshot, exactText] of [
                [fixture.snapshot, '{"revision":"same"}'],
                [same, '{"revision":"same"}'],
                [changed, '{"revision":"changed"}'],
            ] as const) {
                const document = {};
                rememberControlResponseDocument(document, exactText);
                session.associate(snapshot, {
                    source: 'root-snapshot',
                    rootDocument: document,
                });
            }
            const state: RecipeConsoleUrlState = {
                v: 1, experience: 'recipe-console', view: 'tune',
            };
            const renderSnapshot = async (snapshot: ControlServerSnapshot) =>
                act(async () => root?.render(createElement(HistoryWorkspace, {
                    ...retentionProps(),
                    navigate: vi.fn(),
                    onCopyLink: vi.fn(),
                    query: query({
                        status: 'live', snapshot, source: 'root-snapshot',
                        completeness: 'complete',
                    }),
                    urlState: state,
                })));
            const range = () => container.querySelector(
                '[data-history-window-controls] [role="status"]',
            )?.textContent;

            await renderSnapshot(fixture.snapshot);
            const next = [...container.querySelectorAll<HTMLButtonElement>(
                '[data-history-window-controls] button',
            )].find(button => button.textContent === 'Next');
            await act(async () => next?.click());
            expect(range()).toBe('Showing 81–160 of 161 runs.');
            await renderSnapshot(same);
            expect(range()).toBe('Showing 81–160 of 161 runs.');
            await renderSnapshot(changed);
            expect(range()).toBe('Showing 1–80 of 161 runs.');
        });
});
