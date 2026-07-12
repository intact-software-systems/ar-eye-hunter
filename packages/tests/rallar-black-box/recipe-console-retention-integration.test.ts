// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeConsoleControlRetentionCapability } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { RecipeConsoleControlRetentionApi } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-api.ts';
import type { ControlRetentionPreview } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts';
import { HistoryWorkspace } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryWorkspace.tsx';
import type { HistoryWorkspaceProps } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryWorkspace.tsx';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RAW_PREVIEW = {
    deletedRunIds: [],
    retainedRuns: 3,
    maxRuns: 1,
    dryRun: true,
    wouldDeleteRuns: [{
        runId: 'control-delete',
        createdAtEpochMs: 10,
        updatedAtEpochMs: 20,
        connectedAgentCount: 1,
        issuedRunTokenCount: 2,
        distributedRuns: [{
            distributedRunId: 'distributed-delete',
            state: 'failed',
        }],
        fleetReportIds: ['distributed-delete'],
    }],
    wouldDeleteRunIds: ['control-delete'],
    wouldDeleteDistributedRunIds: ['distributed-delete'],
    wouldDeleteFleetReportIds: ['distributed-delete'],
    projectedRetainedRuns: 2,
    preserves: { connectedAgentSockets: true, storedArtifactFiles: true },
    planToken: 'opaque-token-must-never-render',
} as unknown as ControlRetentionPreview;

const URL_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
    controlRunId: 'control-delete',
    distributedRunId: 'distributed-delete',
    agentId: 'agent-delete',
    recipeId: 'recipe-delete',
    commandId: 'command-delete',
    compareLeft: 'distributed-survive',
    compareRight: 'distributed-delete',
    historyQuery: 'ack',
    historyGroup: 'group-a',
    timingMetric: 'stream-drift',
};

function retentionFixture(confirmError?: unknown) {
    const lifetime = new AbortController();
    const api: RecipeConsoleControlRetentionApi = {
        preview: vi.fn(async () => RAW_PREVIEW),
        confirm: vi.fn(async () => {
            if (confirmError) throw confirmError;
            return {
                deletedRunIds: ['control-delete'],
                retainedRuns: 2,
                maxRuns: 1,
            };
        }),
    };
    const load = vi.fn(async () => api);
    const capability: RecipeConsoleControlRetentionCapability = {
        generation: Symbol('retention-integration'),
        signal: lifetime.signal,
        load,
    };
    return { api, capability, load };
}

function query(
    authorization: 'ready' | 'required' = 'ready',
): HistoryWorkspaceProps['query'] {
    return {
        status: 'live',
        reachability: 'reachable',
        authorization,
        snapshot: { runs: [], distributedRuns: [] },
        completeness: 'complete',
        provenance: { distributedRunsSource: 'root-snapshot' },
        receivedAtEpochMs: 1_000,
        isRefreshing: false,
    };
}

describe('History retention integration', () => {
    let container: HTMLDivElement;
    let root: Root;
    let values: Map<string, string>;
    let storageWrites: Array<Readonly<{ key: string; value: string }>>;

    beforeEach(() => {
        values = new Map();
        storageWrites = [];
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => {
                    storageWrites.push({ key, value });
                    values.set(key, value);
                },
                removeItem: (key: string) => values.delete(key),
            },
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('previews, confirms, refreshes, then selectively replaces URL state', async () => {
        const fixture = retentionFixture();
        const order: string[] = [];
        vi.mocked(fixture.api.confirm).mockImplementation(async () => {
            order.push('confirm');
            return { deletedRunIds: ['control-delete'], retainedRuns: 2, maxRuns: 1 };
        });
        const refreshAfterCurrent = vi.fn(async () => {
            order.push('refresh');
        });
        const replace = vi.fn((patch: Partial<RecipeConsoleUrlState>) => {
            order.push('replace');
            return patch;
        });
        await render({
            query: query(),
            retention: fixture.capability,
            refreshAfterCurrent,
            replace,
        });

        expect(fixture.load).not.toHaveBeenCalled();
        await click('Preview cleanup');
        expect(fixture.load).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('control-delete');
        expect(container.innerHTML).not.toContain('opaque-token');
        expect(storageWrites).toEqual([]);
        expect(JSON.stringify(storageWrites)).not.toContain('opaque-token');
        await click('Review cleanup');
        expect(document.activeElement?.textContent).toBe('Keep history');
        await click('Delete previewed runs');
        await vi.waitFor(() => expect(order).toEqual([
            'confirm', 'refresh', 'replace',
        ]));

        expect(replace).toHaveBeenCalledWith({
            controlRunId: undefined,
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            compareRight: undefined,
        });
        expect(URL_STATE).toMatchObject({
            historyQuery: 'ack',
            historyGroup: 'group-a',
            compareLeft: 'distributed-survive',
            timingMetric: 'stream-drift',
        });
        await vi.waitFor(() => expect(container.textContent)
            .toContain('Cleanup completed'));
        expect(document.activeElement?.textContent).toBe('Preview cleanup');
    });

    it('keeps preview unavailable when operator authorization is required', async () => {
        const fixture = retentionFixture();
        await render({ query: query('required'), retention: fixture.capability });

        expect(container.textContent).toContain('Operator authorization is required');
        expect(button('Preview cleanup').disabled).toBe(true);
        expect(fixture.load).not.toHaveBeenCalled();
    });

    it('withholds cleanup when credential provenance is unsafe', async () => {
        const fixture = retentionFixture();
        await render({
            query: {
                ...query(),
                lastError: {
                    kind: 'http',
                    message: 'Automatic control credentials were withheld.',
                    credentialTrustRequired: true,
                },
            },
            retention: fixture.capability,
        });

        expect(container.textContent).toContain(
            'Automatic control credentials were withheld.',
        );
        expect(button('Preview cleanup').disabled).toBe(true);
        expect(fixture.load).not.toHaveBeenCalled();
    });

    it.each([
        ['Keep history', 'button'],
        ['Escape', 'escape'],
        ['outside dismissal', 'backdrop'],
    ] as const)(
        'cancels through %s without issuing a destructive request',
        async (_label, mode) => {
            const fixture = retentionFixture();
            await render({ query: query(), retention: fixture.capability });
            await click('Preview cleanup');
            await click('Review cleanup');

            if (mode === 'button') {
                await click('Keep history');
            } else if (mode === 'escape') {
                const dialog = container.querySelector('[role="alertdialog"]');
                await act(async () => dialog?.dispatchEvent(new KeyboardEvent(
                    'keydown',
                    { key: 'Escape', bubbles: true },
                )));
            } else {
                const backdrop = container.querySelector<HTMLElement>(
                    '[data-retention-confirm-dialog]',
                );
                await act(async () => backdrop?.click());
            }

            expect(container.querySelector('[role="alertdialog"]')).toBeNull();
            expect(container.textContent).toContain('Current preview');
            expect(document.activeElement?.textContent).toBe('Preview cleanup');
            expect(fixture.api.confirm).not.toHaveBeenCalled();
            expect(storageWrites).toEqual([]);
        },
    );

    it('closes a drifted dialog, restores Preview focus, and requires a new preview', async () => {
        const fixture = retentionFixture(Object.assign(
            new Error('Retention plan drifted.'),
            { status: 409 },
        ));
        await render({ query: query(), retention: fixture.capability });
        await click('Preview cleanup');
        await click('Review cleanup');
        await click('Delete previewed runs');

        await vi.waitFor(() => expect(container.textContent)
            .toContain('Retention plan drifted.'));
        expect(container.querySelector('[role="alertdialog"]')).toBeNull();
        expect(container.textContent).toContain('Stale preview · not current');
        expect(document.activeElement?.textContent).toBe('Preview cleanup');
        expect(fixture.api.confirm).toHaveBeenCalledTimes(1);
    });

    it('suppresses URL reconciliation when context changes during refresh', async () => {
        const first = retentionFixture();
        const second = retentionFixture();
        let resolveRefresh!: () => void;
        const refresh = new Promise<void>(resolve => {
            resolveRefresh = resolve;
        });
        const refreshAfterCurrent = vi.fn(() => refresh);
        const replace = vi.fn();
        await render({
            query: query(),
            retention: first.capability,
            refreshAfterCurrent,
            replace,
        });
        await click('Preview cleanup');
        await click('Review cleanup');
        await click('Delete previewed runs');
        await vi.waitFor(() => expect(refreshAfterCurrent).toHaveBeenCalledTimes(1));

        await render({
            query: query(),
            retention: second.capability,
            refreshAfterCurrent,
            replace,
        });
        await act(async () => resolveRefresh());
        await act(async () => Promise.resolve());

        expect(replace).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Stale preview · not current');
        expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    });

    it('aborts reconciliation when authorization is lost without API replacement',
        async () => {
            const fixture = retentionFixture();
            let resolveRefresh!: () => void;
            const refresh = new Promise<void>(resolve => {
                resolveRefresh = resolve;
            });
            const refreshAfterCurrent = vi.fn(() => refresh);
            const replace = vi.fn();
            await render({
                query: query(),
                retention: fixture.capability,
                refreshAfterCurrent,
                replace,
            });
            await click('Preview cleanup');
            await click('Review cleanup');
            await click('Delete previewed runs');
            await vi.waitFor(() => expect(refreshAfterCurrent)
                .toHaveBeenCalledTimes(1));

            await render({
                query: query('required'),
                retention: fixture.capability,
                refreshAfterCurrent,
                replace,
            });
            await act(async () => resolveRefresh());
            await act(async () => Promise.resolve());

            expect(replace).not.toHaveBeenCalled();
            expect(container.textContent).toContain(
                'Operator authorization is required.',
            );
            expect(container.querySelector('[role="alertdialog"]')).toBeNull();
        });

    async function render(overrides: Partial<HistoryWorkspaceProps>): Promise<void> {
        await act(async () => root.render(createElement(HistoryWorkspace, {
            query: query(),
            urlState: URL_STATE,
            navigate: vi.fn(),
            onCopyLink: vi.fn(),
            retention: undefined,
            replace: vi.fn(),
            refreshAfterCurrent: vi.fn(async () => {}),
            ...overrides,
        })));
    }

    function button(text: string): HTMLButtonElement {
        const match = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(candidate => candidate.textContent === text);
        if (!match) throw new Error(`Missing button ${text}`);
        return match;
    }

    async function click(text: string): Promise<void> {
        await act(async () => button(text).click());
        await act(async () => Promise.resolve());
    }
});
