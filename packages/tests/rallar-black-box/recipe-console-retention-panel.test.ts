// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionPanel } from
    '../../../apps/rallar-black-box/src/recipe-console/history/RetentionPanel.tsx';
import type {
    RetentionCleanupController,
    RetentionCleanupPreview,
} from '../../../apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const preview: RetentionCleanupPreview = {
    current: true,
    retainedRuns: 5,
    maxRuns: 3,
    projectedRetainedRuns: 3,
    candidates: [{
        key: 'retention-candidate:0',
        runId: '  control/unsafe\u202e  ',
        createdAtEpochMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        updatedAtEpochMs: Date.UTC(2026, 0, 2, 4, 5, 6),
        connectedAgentCount: 2,
        issuedRunTokenCount: 3,
        distributedRuns: [{
            distributedRunId: 'distributed/one?unsafe=1',
            state: 'failed',
        }, {
            distributedRunId: 'distributed:two',
            state: 'running',
        }],
        fleetReportIds: ['fleet/report:one'],
    }, {
        key: 'retention-candidate:1',
        runId: 'control-safe',
        createdAtEpochMs: Date.UTC(2026, 1, 3, 3, 4, 5),
        updatedAtEpochMs: Date.UTC(2026, 1, 3, 4, 5, 6),
        connectedAgentCount: 0,
        issuedRunTokenCount: 1,
        distributedRuns: [{
            distributedRunId: 'distributed-three',
            state: 'passed',
        }],
        fleetReportIds: ['fleet-two'],
    }],
    wouldDeleteRunIds: ['  control/unsafe\u202e  ', 'control-safe'],
    wouldDeleteDistributedRunIds: [
        'distributed/one?unsafe=1',
        'distributed:two',
        'distributed-three',
    ],
    wouldDeleteFleetReportIds: ['fleet/report:one', 'fleet-two'],
    preserves: {
        connectedAgentSockets: true,
        storedArtifactFiles: true,
    },
};

function cleanupController(
    patch: Partial<RetentionCleanupController> = {},
): RetentionCleanupController {
    return {
        state: { status: 'idle' },
        canPreview: true,
        canConfirm: false,
        busy: false,
        preview: vi.fn(async () => {}),
        confirm: vi.fn(async () => {}),
        ...patch,
    } as RetentionCleanupController;
}

async function clickSummary(
    owner: ParentNode | undefined,
    label: string,
): Promise<void> {
    const summary = [...owner?.querySelectorAll('summary') ?? []].find(row =>
        row.textContent?.startsWith(label)
    );
    expect(summary, label).toBeDefined();
    await act(async () => summary?.click());
}

function pressureRowCount(owner: ParentNode): number {
    return owner.querySelectorAll([
        '[data-retention-candidate-row]',
        '[data-retention-linked-run-row]',
        '[data-retention-linked-fleet-row]',
        '[data-retention-total-id-row]',
    ].join(',')).length;
}

describe('RetentionPanel', () => {
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

    async function render(
        controller: RetentionCleanupController,
        onRequestConfirm = vi.fn(),
    ) {
        await act(async () => root.render(createElement(RetentionPanel, {
            controller,
            onRequestConfirm,
        })));
        return { onRequestConfirm };
    }

    it('always offers one visible preview action and issues one preview request',
        async () => {
            const previewRequest = vi.fn(async () => {});
            await render(cleanupController({ preview: previewRequest }));

            const section = container.querySelector('[data-retention-panel]');
            const button = [...container.querySelectorAll('button')].find(item =>
                item.textContent === 'Preview cleanup'
            );
            expect(section?.textContent).toContain('Signal ledger');
            expect(section?.textContent).toContain('Local history retention');
            expect(button?.disabled).toBe(false);

            await act(async () => button?.click());
            expect(previewRequest).toHaveBeenCalledTimes(1);
            expect(container.textContent).not.toContain('Review cleanup');

            await render(cleanupController({ canPreview: false }));
            expect((container.querySelector('button') as HTMLButtonElement).disabled)
                .toBe(true);
            await render(cleanupController({ busy: true }));
            expect((container.querySelector('button') as HTMLButtonElement).disabled)
                .toBe(true);
        });

    it('shows every exact candidate and consequence before requesting review',
        async () => {
            const onRequestConfirm = vi.fn();
            await render(cleanupController({
                state: { status: 'preview-ready', preview },
                canConfirm: true,
            }), onRequestConfirm);

            let text = container.textContent ?? '';
            expect(text).toContain('5 current');
            expect(text).toContain('3 projected');
            expect(text).toContain('Cap 3');
            expect(text).toContain('2 control runs');
            expect(text).toContain('3 distributed runs');
            expect(text).toContain('2 fleet reports');
            expect(container.querySelectorAll('[data-retention-linked-run-row]'))
                .toHaveLength(0);
            expect(container.querySelectorAll('[data-retention-total-id-row]'))
                .toHaveLength(0);
            expect(text).toContain('2 connected agents');
            expect(text).toContain('3 issued run tokens');
            expect(text).toContain('0 connected agents');
            expect(text).toContain('1 issued run token');
            expect(text).toContain('2026-01-02T03:04:05.000Z');
            expect(text).toContain('2026-01-02T04:05:06.000Z');
            expect(text).toContain(
                'In-memory control, distributed, and fleet state is deleted.',
            );
            expect(text).toContain(
                'Existing connected sockets and stored artifact files remain.',
            );

            const candidates = [...container.querySelectorAll(
                '[data-retention-candidate-row]',
            )];
            await clickSummary(candidates[0], 'Linked distributed runs');
            text = container.textContent ?? '';
            expect(text).toContain('distributed/one?unsafe=1');
            expect(text).toContain('failed');
            expect(text).toContain('distributed:two');
            expect(text).toContain('running');
            expect(pressureRowCount(container)).toBeLessThanOrEqual(100);

            await clickSummary(candidates[0], 'Linked fleet reports');
            expect(container.querySelectorAll('[data-retention-linked-run-row]'))
                .toHaveLength(0);
            expect(container.textContent).toContain('fleet/report:one');
            expect(pressureRowCount(container)).toBeLessThanOrEqual(100);

            await clickSummary(candidates[1], 'Linked distributed runs');
            expect(container.textContent).toContain('distributed-three');
            expect(container.textContent).not.toContain('fleet/report:one');
            expect(pressureRowCount(container)).toBeLessThanOrEqual(100);

            for (const [label, ids] of [
                ['Control run IDs', preview.wouldDeleteRunIds],
                ['Distributed run IDs', preview.wouldDeleteDistributedRunIds],
                ['Fleet report IDs', preview.wouldDeleteFleetReportIds],
            ] as const) {
                await clickSummary(container, label);
                for (const id of ids) expect(container.textContent).toContain(id);
                expect(pressureRowCount(container)).toBeLessThanOrEqual(100);
            }

            const details = [...container.querySelectorAll('details')];
            expect(details.length).toBeGreaterThanOrEqual(6);
            expect(details.every(item => item.querySelector('summary'))).toBe(true);

            const previewButton = [...container.querySelectorAll('button')].find(
                item => item.textContent === 'Preview cleanup',
            );
            const reviewButton = [...container.querySelectorAll('button')].find(
                item => item.textContent === 'Review cleanup',
            );
            expect(reviewButton).toBeDefined();
            await act(async () => reviewButton?.click());
            expect(onRequestConfirm).toHaveBeenCalledTimes(1);
            expect(container.querySelectorAll('[data-retention-total-id-row]'))
                .toHaveLength(0);
            expect(onRequestConfirm).toHaveBeenCalledWith(previewButton);
        });

    it('renders exact whitespace and bidi-bearing IDs in an isolated LTR owner',
        async () => {
            await render(cleanupController({
                state: { status: 'preview-ready', preview },
                canConfirm: true,
            }));

            const unsafeId = preview.wouldDeleteRunIds[0];
            const rendered = [...container.querySelectorAll<HTMLElement>(
                'bdi[data-exact-identifier]',
            )].find(element => element.textContent === unsafeId);
            expect(rendered?.textContent).toBe(unsafeId);
            expect(rendered?.getAttribute('dir')).toBe('ltr');

        });

    it('has no destructive action for an empty plan or disabled zero cap', async () => {
        const empty = {
            ...preview,
            candidates: [],
            wouldDeleteRunIds: [],
            wouldDeleteDistributedRunIds: [],
            wouldDeleteFleetReportIds: [],
            retainedRuns: 3,
            projectedRetainedRuns: 3,
        } satisfies RetentionCleanupPreview;
        await render(cleanupController({
            state: { status: 'preview-ready', preview: empty },
            canConfirm: false,
        }));
        expect(container.textContent).toContain('No in-memory history would be deleted');
        expect(container.textContent).not.toContain('Review cleanup');

        await render(cleanupController({
            state: {
                status: 'preview-ready',
                preview: { ...empty, maxRuns: 0 },
            },
            canConfirm: false,
        }));
        expect(container.textContent).toContain('Retention cap is disabled');
        expect(container.textContent).not.toContain('Review cleanup');
    });

    it('keeps drifted consequences visible as stale and never offers review',
        async () => {
            await render(cleanupController({
                state: {
                    status: 'drift',
                    message: 'The server state changed; preview cleanup again.',
                    preview: { ...preview, current: false },
                },
                canConfirm: false,
            }));

            const status = container.querySelector('[role="status"]');
            expect(status?.getAttribute('aria-live')).toBe('polite');
            expect(status?.textContent).toContain(
                'The server state changed; preview cleanup again.',
            );
            expect(container.textContent).toContain('Stale preview · not current');
            const linked = [...container.querySelectorAll('details')].find(details =>
                details.querySelector('summary')?.textContent?.startsWith(
                    'Linked distributed runs',
                )
            );
            await act(async () => linked?.querySelector('summary')?.click());
            expect(container.textContent).toContain('distributed/one?unsafe=1');
            expect(container.textContent).not.toContain('Review cleanup');
        });

    it('announces idle, busy, success, error, and unavailable state text',
        async () => {
            const expected = [
                ['idle', 'Preview retention consequences before cleanup.'],
                ['previewing', 'Building retention preview…'],
                ['preview-ready', 'Retention preview is current.'],
                ['confirming', 'Deleting previewed in-memory history…'],
                ['succeeded', 'Retention cleanup succeeded.'],
                ['error', 'Retention cleanup failed.'],
                ['unavailable', 'Retention cleanup is unavailable.'],
            ] as const;
            for (const [status, message] of expected) {
                await render(cleanupController({ state: { status } }));
                expect(container.querySelector('[role="status"]')?.textContent)
                    .toContain(message);
            }

            await render(cleanupController({
                state: { status: 'error', message: 'Authorization denied.' },
            }));
            expect(container.querySelector('[role="status"]')?.textContent)
                .toContain('Authorization denied.');
        });

    it('shows the exact successful deletion result without exposing secret state',
        async () => {
            await render(cleanupController({
                state: {
                    status: 'succeeded',
                    confirmation: {
                        deletedRunIds: ['deleted/control:one', 'deleted/control/two'],
                        retainedRuns: 3,
                        maxRuns: 3,
                    },
                },
            }));

            const result = [...container.querySelectorAll('details')].find(details =>
                details.querySelector('summary')?.textContent?.startsWith(
                    'Deleted control run IDs',
                )
            );
            expect(container.textContent).not.toContain('deleted/control:one');
            await act(async () => result?.querySelector('summary')?.click());
            const text = container.textContent ?? '';
            expect(text).toContain('Cleanup completed');
            expect(text).toContain('2 control runs deleted');
            expect(text).toContain('3 retained');
            expect(text).toContain('Cap 3');
            expect(text).toContain('deleted/control:one');
            expect(text).toContain('deleted/control/two');
        });

    });
