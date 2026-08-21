// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionConfirmDialog } from '../../../apps/rallar-black-box/src/recipe-console/history/RetentionConfirmDialog.tsx';
import { RetentionPanel } from '../../../apps/rallar-black-box/src/recipe-console/history/RetentionPanel.tsx';
import type { RetentionCleanupController, RetentionCleanupPreview } from '../../../apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts';
import { createRecipeConsoleControlScaleFixture } from '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console retention pressure windows', () => {
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

    async function renderPanel(
        preview: RetentionCleanupPreview | undefined,
        confirmation?: Readonly<{
            deletedRunIds: readonly string[];
            retainedRuns: number;
            maxRuns: number;
        }>
    ): Promise<void> {
        const state = confirmation
            ? { status: 'succeeded' as const, confirmation }
            : preview
            ? { status: 'preview-ready' as const, preview }
            : { status: 'idle' as const };
        const controller: RetentionCleanupController = {
            state,
            canPreview: true,
            canConfirm: Boolean(preview),
            busy: false,
            preview: vi.fn(async () => {}),
            confirm: vi.fn(async () => {})
        };
        await act(async () =>
            root.render(createElement(RetentionPanel, {
                controller,
                onRequestConfirm: vi.fn()
            }))
        );
    }

    async function click(element: Element | null): Promise<void> {
        if (!(element instanceof HTMLElement)) {
            throw new Error('Missing click target.');
        }
        await act(async () => element.click());
    }

    async function next(label: string, count = 1): Promise<void> {
        for (let index = 0; index < count; index += 1) {
            await click(windowButton(label, 'Next'));
        }
    }

    function windowButton(label: string, action: 'Next' | 'Previous') {
        const group = [...container.querySelectorAll('[role="group"]')]
            .find((row) => row.getAttribute('aria-label') === `${label} window`);
        return [...group?.querySelectorAll('button') ?? []]
            .find((row) => row.textContent === action) ?? null;
    }

    it('bounds 205 preview candidates and every global consequence list at 100', async () => {
        const preview = scalePreview({
            pairCount: 205,
            candidateCount: 205,
            distributedRunsPerCandidate: 1,
            fleetReportsPerCandidate: 1
        });
        await renderPanel(preview);

        expect(container.querySelectorAll('[data-retention-candidate-row]'))
            .toHaveLength(50);
        expect(container.textContent).toContain('Showing 1–50 of 205 candidates.');
        expect(container.querySelectorAll('[data-retention-linked-run-row]'))
            .toHaveLength(0);
        expect(container.querySelectorAll('[data-retention-linked-fleet-row]'))
            .toHaveLength(0);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(0);

        await next('Retention candidates', 4);
        expect(container.querySelectorAll('[data-retention-candidate-row]'))
            .toHaveLength(5);
        expect(container.textContent).toContain(preview.candidates[204]!.runId);

        for (
            const label of [
                'Control run IDs',
                'Distributed run IDs',
                'Fleet report IDs'
            ]
        ) {
            const consequence = [...container.querySelectorAll('details')]
                .find((row) =>
                    row.querySelector('summary')?.textContent
                        ?.startsWith(label)
                );
            await click(consequence?.querySelector('summary') ?? null);
            expect(container.querySelectorAll('[data-retention-total-id-row]'))
                .toHaveLength(50);
            expect(consequence?.textContent).toContain(
                `Showing 1–50 of 205 IDs.`
            );
            await click(consequence?.querySelector('summary') ?? null);
            expect(container.querySelectorAll('[data-retention-total-id-row]'))
                .toHaveLength(0);
        }
        const disclosure = [...container.querySelectorAll('details')]
            .find((row) =>
                row.querySelector('summary')?.textContent
                    ?.startsWith('Control run IDs')
            );
        await click(disclosure?.querySelector('summary') ?? null);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(50);
        expect(disclosure?.textContent).toContain('Showing 1–50 of 205 IDs.');
        await next('Control run IDs', 4);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(5);
        expect(disclosure?.textContent).toContain(preview.wouldDeleteRunIds[204]);
    });

    it('resets a new preview revision and recovers focus from the old window', async () => {
        const input = {
            pairCount: 205,
            candidateCount: 205,
            distributedRunsPerCandidate: 1,
            fleetReportsPerCandidate: 0
        } as const;
        const first = scalePreview(input);
        await renderPanel(first);
        await next('Retention candidates');
        const focused = container.querySelector<HTMLElement>(
            '[data-retention-candidate-row] summary'
        );
        focused?.focus();
        expect(document.activeElement).toBe(focused);

        const replacement = scalePreview(input);
        await renderPanel(replacement);
        expect(container.textContent).toContain(replacement.candidates[0]!.runId);
        expect(container.textContent).not.toContain(replacement.candidates[100]!.runId);
        expect(document.activeElement).toBe(container.querySelector(
            '[data-retention-window-focus-anchor="Retention candidates"]'
        ));
    });

    it('hands focus to persistent range truth at both disabled boundaries', async () => {
        const preview = scalePreview({
            pairCount: 205,
            candidateCount: 205,
            distributedRunsPerCandidate: 1,
            fleetReportsPerCandidate: 0
        });
        await renderPanel(preview);

        await next('Retention candidates', 3);
        const finalNext = windowButton('Retention candidates', 'Next');
        (finalNext as HTMLElement | null)?.focus();
        await click(finalNext);
        expect(finalNext).toHaveProperty('disabled', true);
        expect(document.activeElement).toBe(container.querySelector(
            '[data-retention-window-focus-anchor="Retention candidates"]'
        ));

        await click(windowButton('Retention candidates', 'Previous'));
        await click(windowButton('Retention candidates', 'Previous'));
        await click(windowButton('Retention candidates', 'Previous'));
        const firstPrevious = windowButton('Retention candidates', 'Previous');
        (firstPrevious as HTMLElement | null)?.focus();
        await click(firstPrevious);
        expect(firstPrevious).toHaveProperty('disabled', true);
        expect(document.activeElement).toBe(container.querySelector(
            '[data-retention-window-focus-anchor="Retention candidates"]'
        ));
    });

    it('unmounts closed linked consequences and traverses exact 201-row lists', async () => {
        const preview = scalePreview({
            pairCount: 4,
            candidateCount: 1,
            distributedRunsPerCandidate: 201,
            fleetReportsPerCandidate: 201
        });
        await renderPanel(preview);
        const candidate = container.querySelector('[data-retention-candidate-row]');
        const details = [...candidate?.querySelectorAll('details') ?? []];

        expect(details).toHaveLength(2);
        expect(candidate?.querySelectorAll('[data-retention-linked-run-row]'))
            .toHaveLength(0);
        expect(candidate?.querySelectorAll('[data-retention-linked-fleet-row]'))
            .toHaveLength(0);

        await click(details[0]?.querySelector('summary') ?? null);
        expect(candidate?.querySelectorAll('[data-retention-linked-run-row]'))
            .toHaveLength(50);
        await next('Linked distributed runs', 4);
        expect(candidate?.querySelectorAll('[data-retention-linked-run-row]'))
            .toHaveLength(1);
        expect(details[0]?.textContent).toContain(
            preview.candidates[0]!.distributedRuns[200]!.distributedRunId
        );
        await click(details[0]?.querySelector('summary') ?? null);
        expect(candidate?.querySelectorAll('[data-retention-linked-run-row]'))
            .toHaveLength(0);

        await click(details[1]?.querySelector('summary') ?? null);
        expect(candidate?.querySelectorAll('[data-retention-linked-fleet-row]'))
            .toHaveLength(50);
        await next('Linked fleet reports', 4);
        expect(candidate?.querySelectorAll('[data-retention-linked-fleet-row]'))
            .toHaveLength(1);
        expect(details[1]?.textContent).toContain(
            preview.candidates[0]!.fleetReportIds[200]
        );
    });

    it('bounds the confirmation dialog and successful deletion result independently', async () => {
        const preview = scalePreview({
            pairCount: 205,
            candidateCount: 205,
            distributedRunsPerCandidate: 1,
            fleetReportsPerCandidate: 0
        });
        const restoreFocus = document.createElement('button');
        document.body.append(restoreFocus);
        await act(async () =>
            root.render(createElement(RetentionConfirmDialog, {
                open: true,
                preview,
                busy: false,
                restoreFocus,
                onCancel: vi.fn(),
                onConfirm: vi.fn()
            }))
        );

        expect(container.querySelectorAll('[data-retention-dialog-candidate-row]'))
            .toHaveLength(50);
        expect(container.textContent).toContain('Showing 1–50 of 205 candidates.');
        await next('Previewed runs to delete', 4);
        expect(container.querySelectorAll('[data-retention-dialog-candidate-row]'))
            .toHaveLength(5);
        expect(container.textContent).toContain(preview.candidates[204]!.runId);
        await act(async () => root.render(null));
        restoreFocus.remove();

        await renderPanel(undefined, {
            deletedRunIds: preview.wouldDeleteRunIds,
            retainedRuns: 1,
            maxRuns: 1
        });
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(0);
        const result = [...container.querySelectorAll('details')].find((row) =>
            row.querySelector('summary')?.textContent?.startsWith(
                'Deleted control run IDs'
            )
        );
        await click(result?.querySelector('summary') ?? null);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(50);
        await next('Deleted control run IDs', 4);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(5);
    });

    it('coordinates every nested and global disclosure under one surface budget', async () => {
        const preview = scalePreview({
            pairCount: 4,
            candidateCount: 4,
            distributedRunsPerCandidate: 100,
            fleetReportsPerCandidate: 100
        });
        await renderPanel(preview);

        const candidateSummaries = [...container.querySelectorAll(
            '[data-retention-candidate-row] summary'
        )];
        for (const summary of candidateSummaries) {
            await click(summary);
            expect(pressureRowCount(container)).toBeLessThanOrEqual(100);
        }
        const globalLabels = [
            'Control run IDs',
            'Distributed run IDs',
            'Fleet report IDs'
        ];
        const globalSummaries = [...container.querySelectorAll(
            'details > summary'
        )].filter((summary) => globalLabels.some((label) => summary.textContent?.startsWith(label)));
        for (const summary of globalSummaries) {
            await click(summary);
            expect(pressureRowCount(container)).toBeLessThanOrEqual(100);
        }
        expect(container.querySelectorAll('[data-retention-candidate-row]'))
            .toHaveLength(4);
        expect(container.querySelectorAll('[data-retention-total-id-row]'))
            .toHaveLength(50);
    });
});

function pressureRowCount(container: ParentNode): number {
    return container.querySelectorAll([
        '[data-retention-candidate-row]',
        '[data-retention-linked-run-row]',
        '[data-retention-linked-fleet-row]',
        '[data-retention-total-id-row]',
        '[data-retention-dialog-candidate-row]'
    ].join(',')).length;
}

function scalePreview(
    input: Readonly<{
        pairCount: number;
        candidateCount: number;
        distributedRunsPerCandidate: number;
        fleetReportsPerCandidate: number;
    }>
): RetentionCleanupPreview {
    const fixture = createRecipeConsoleControlScaleFixture({
        pairCount: input.pairCount,
        retention: {
            candidateCount: input.candidateCount,
            distributedRunsPerCandidate: input.distributedRunsPerCandidate,
            fleetReportsPerCandidate: input.fleetReportsPerCandidate
        }
    });
    return {
        current: true,
        retainedRuns: input.candidateCount + 1,
        maxRuns: 1,
        projectedRetainedRuns: 1,
        candidates: fixture.retention.candidates.map((candidate, index) => ({
            key: `retention-candidate:${index}`,
            ...candidate
        })),
        wouldDeleteRunIds: fixture.retention.wouldDeleteRunIds,
        wouldDeleteDistributedRunIds: fixture.retention.wouldDeleteDistributedRunIds,
        wouldDeleteFleetReportIds: fixture.retention.wouldDeleteFleetReportIds,
        preserves: {
            connectedAgentSockets: true,
            storedArtifactFiles: true
        }
    };
}
