// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryTable } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryTable.tsx';
import type {
    RecipeConsoleHistoryModel,
    RecipeConsoleHistoryRow,
} from '../../../apps/rallar-black-box/src/recipe-console/history/history-model.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const baselinePatch = { compareLeft: 'distributed-safe' } satisfies
    Partial<RecipeConsoleUrlState>;
const candidatePatch = {
    compareRight: 'distributed-safe',
    distributedRunId: 'distributed-safe',
    controlRunId: 'control-safe',
} satisfies Partial<RecipeConsoleUrlState>;

function historyRow(
    patch: Partial<RecipeConsoleHistoryRow> = {},
): RecipeConsoleHistoryRow {
    return {
        key: 'history-row:0',
        distributedRunId: 'distributed-safe',
        controlRunId: 'control-safe',
        state: 'failed',
        createdAtEpochMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        updatedAtEpochMs: Date.UTC(2026, 0, 2, 4, 5, 6),
        labels: {
            displayName: 'RTC smoke',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-eu-west',
                label: 'rallar-server / default / group-eu-west',
            },
            recipes: [{
                recipeId: 'rtc-stream',
                profile: 'smoke',
                label: 'rtc-stream · smoke',
            }],
            failures: [{
                category: 'readiness',
                code: 'RALLAR_ACK_TIMEOUT',
                message: 'Agent acknowledgement timed out',
                label: 'RALLAR_ACK_TIMEOUT: Agent acknowledgement timed out',
            }],
        },
        pairStatus: 'paired',
        controlStatus: 'paired-connected',
        agentCount: 3,
        connectedAgentCount: 2,
        quarantined: false,
        quarantineCodes: [],
        issues: [],
        actions: {
            eligible: true,
            identity: {
                distributedRunId: 'distributed-safe',
                controlRunId: 'control-safe',
            },
            baselinePatch,
            candidatePatch,
        },
        ...patch,
    };
}

function historyModel(
    rows: readonly RecipeConsoleHistoryRow[],
    counts: RecipeConsoleHistoryModel['counts'] = {
        available: rows.length,
        total: rows.length,
        rendered: rows.length,
        omitted: 0,
    },
): RecipeConsoleHistoryModel {
    return {
        provenance: {
            status: 'live',
            distributedRunsSource: 'root-snapshot',
            freshness: 'current',
            completeness: 'complete',
        },
        counts,
        rows,
    };
}

describe('HistoryTable', () => {
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

    async function render(model: RecipeConsoleHistoryModel, onBaseline = vi.fn(),
        onCandidate = vi.fn()) {
        root = createRoot(container);
        await act(async () => root?.render(createElement(HistoryTable, {
            model,
            onBaseline,
            onCandidate,
        })));
        return { onBaseline, onCandidate };
    }

    it('announces exact filtered, rendered, and omitted counts', async () => {
        await render(historyModel([historyRow()], {
            available: 187,
            total: 132,
            rendered: 1,
            omitted: 131,
        }));

        const announcement = container.querySelector('[aria-live="polite"]');
        expect(announcement?.textContent).toBe(
            '132 filtered · 1 rendered · 131 omitted',
        );
        expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('keeps the named scroll region keyboard-focusable and exposes exact evidence',
        async () => {
            const longDistributedId = 'distributed-run/full:identity/that-must-not-truncate';
            const longControlId = 'control-run/full:identity/that-must-not-truncate';
            await render(historyModel([historyRow({
                distributedRunId: longDistributedId,
                controlRunId: longControlId,
            })]));

            const region = container.querySelector<HTMLElement>(
                '[role="region"][aria-label="Recipe run history"]',
            );
            expect(region?.querySelector('table')).toBeInstanceOf(HTMLTableElement);
            region?.focus();
            expect(document.activeElement).toBe(region);
            expect(region?.textContent).toContain(longDistributedId);
            expect(region?.textContent).toContain(longControlId);
            expect(region?.textContent).toContain('failed');
            expect(region?.textContent).toContain('2026-01-02T03:04:05.000Z');
            expect(region?.textContent).toContain('2026-01-02T04:05:06.000Z');
            expect(region?.textContent).toContain(
                'rallar-server / default / group-eu-west',
            );
            expect(region?.textContent).toContain('rtc-stream · smoke');
            expect(region?.textContent).toContain(
                'RALLAR_ACK_TIMEOUT: Agent acknowledgement timed out',
            );
            expect(region?.textContent).toContain('Paired control');
            expect(region?.textContent).toContain('2 of 3 agents connected');
        });

    it('preserves and bidi-isolates exact quarantined run identities', async () => {
        const distributedRunId = '  distributed/unsafe\u202e  ';
        const controlRunId = '  control/unsafe\u202d  ';
        await render(historyModel([historyRow({
            distributedRunId,
            controlRunId,
            quarantined: true,
            quarantineCodes: ['unsafe-identity'],
            actions: {
                eligible: false,
                reason: 'quarantined',
                baselinePatch: {},
                candidatePatch: {},
            },
        })]));

        const identifiers = [...container.querySelectorAll<HTMLElement>(
            'bdi[data-exact-identifier]',
        )];
        expect(identifiers.map(identifier => identifier.textContent)).toEqual([
            distributedRunId,
            controlRunId,
        ]);
        expect(identifiers.every(identifier => identifier.dir === 'ltr')).toBe(true);
    });

    it('passes each safe row precomputed baseline and candidate patch exactly', async () => {
        const onBaseline = vi.fn();
        const onCandidate = vi.fn();
        await render(historyModel([historyRow()]), onBaseline, onCandidate);

        const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
        const baseline = buttons.find(button => button.textContent === 'Baseline');
        const candidate = buttons.find(button => button.textContent === 'Candidate');
        expect(baseline).toBeDefined();
        expect(candidate).toBeDefined();
        expect(baseline?.getAttribute('aria-label')).toBe(
            'Set distributed-safe as comparison baseline',
        );
        expect(candidate?.getAttribute('aria-label')).toBe(
            'Set distributed-safe as comparison candidate',
        );
        await act(async () => baseline?.click());
        await act(async () => candidate?.click());
        expect(onBaseline).toHaveBeenCalledWith(baselinePatch);
        expect(onBaseline.mock.calls[0]?.[0]).toBe(baselinePatch);
        expect(onCandidate).toHaveBeenCalledWith(candidatePatch);
        expect(onCandidate.mock.calls[0]?.[0]).toBe(candidatePatch);
    });

    it('shows quarantined, malformed, duplicate, missing, and ambiguous reasons without actions',
        async () => {
            const blocked = [
                historyRow({
                    key: 'history-row:1',
                    distributedRunId: 'duplicate-run',
                    quarantined: true,
                    quarantineCodes: ['ambiguous-run'],
                    issues: ['Duplicate distributed run identity is ambiguous.'],
                    actions: {
                        eligible: false,
                        reason: 'quarantined',
                        baselinePatch: {},
                        candidatePatch: {},
                    },
                }),
                historyRow({
                    key: 'history-row:2',
                    distributedRunId: 'malformed-run',
                    quarantined: true,
                    quarantineCodes: ['invalid-manifest'],
                    issues: ['Distributed run manifest is malformed.'],
                    actions: {
                        eligible: false,
                        reason: 'quarantined',
                        baselinePatch: {},
                        candidatePatch: {},
                    },
                }),
                historyRow({
                    key: 'history-row:3',
                    distributedRunId: 'missing-control-run',
                    pairStatus: 'missing',
                    controlStatus: 'missing',
                    agentCount: 0,
                    connectedAgentCount: 0,
                    actions: {
                        eligible: false,
                        reason: 'missing-control',
                        baselinePatch: {},
                        candidatePatch: {},
                    },
                }),
                historyRow({
                    key: 'history-row:4',
                    distributedRunId: 'ambiguous-control-run',
                    pairStatus: 'ambiguous',
                    controlStatus: 'ambiguous',
                    agentCount: 0,
                    connectedAgentCount: 0,
                    actions: {
                        eligible: false,
                        reason: 'ambiguous-control',
                        baselinePatch: {},
                        candidatePatch: {},
                    },
                }),
            ];
            await render(historyModel(blocked));

            expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
            expect(container.textContent).toContain('ambiguous-run');
            expect(container.textContent).toContain(
                'Duplicate distributed run identity is ambiguous.',
            );
            expect(container.textContent).toContain('invalid-manifest');
            expect(container.textContent).toContain(
                'Distributed run manifest is malformed.',
            );
            expect(container.textContent).toContain('Missing control pair');
            expect(container.textContent).toContain('Ambiguous control pair');
            expect(container.querySelectorAll('button')).toHaveLength(0);
        });
});
