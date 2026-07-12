// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryWorkspace.tsx';
import type { RecipeConsoleControlQueryProvenance } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import type { ControlServerSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
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
});
