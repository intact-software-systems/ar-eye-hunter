// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
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

            const text = container.textContent ?? '';
            expect(text).toContain('5 current');
            expect(text).toContain('3 projected');
            expect(text).toContain('Cap 3');
            expect(text).toContain('2 control runs');
            expect(text).toContain('3 distributed runs');
            expect(text).toContain('2 fleet reports');
            for (const id of [
                ...preview.wouldDeleteRunIds,
                ...preview.wouldDeleteDistributedRunIds,
                ...preview.wouldDeleteFleetReportIds,
            ]) expect(text).toContain(id);
            expect(text).toContain('2 connected agents');
            expect(text).toContain('3 issued run tokens');
            expect(text).toContain('0 connected agents');
            expect(text).toContain('1 issued run token');
            expect(text).toContain('2026-01-02T03:04:05.000Z');
            expect(text).toContain('2026-01-02T04:05:06.000Z');
            expect(text).toContain('distributed/one?unsafe=1');
            expect(text).toContain('failed');
            expect(text).toContain('distributed:two');
            expect(text).toContain('running');
            expect(text).toContain('fleet/report:one');
            expect(text).toContain(
                'In-memory control, distributed, and fleet state is deleted.',
            );
            expect(text).toContain(
                'Existing connected sockets and stored artifact files remain.',
            );

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

            const css = readFileSync(
                'apps/rallar-black-box/src/recipe-console/history/ExactIdentifier.module.css',
                'utf8',
            );
            expect(css).toMatch(/white-space:\s*break-spaces/);
            expect(css).toMatch(/unicode-bidi:\s*isolate-override/);
            expect(css).toMatch(/direction:\s*ltr/);
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

            const text = container.textContent ?? '';
            expect(text).toContain('Cleanup completed');
            expect(text).toContain('2 control runs deleted');
            expect(text).toContain('3 retained');
            expect(text).toContain('Cap 3');
            expect(text).toContain('deleted/control:one');
            expect(text).toContain('deleted/control/two');
        });

    it('keeps the component source and public props token-free', () => {
        const componentSource = readFileSync(
            'apps/rallar-black-box/src/recipe-console/history/RetentionPanel.tsx',
            'utf8',
        );
        expect(componentSource).toMatch(/import type[\s\S]*use-retention-cleanup/);
        expect(componentSource).toMatch(/controller:\s*RetentionCleanupController/);
        expect(componentSource).toMatch(
            /onRequestConfirm\(returnFocus:\s*HTMLButtonElement\):\s*void/,
        );
        expect(componentSource).toMatch(/key=\{candidate\.key\}/);
        expect(componentSource).not.toMatch(/planToken|rawToken|authorization/i);
        expect(componentSource).not.toMatch(/localStorage|sessionStorage|console\.|fetch\s*\(/);
        expect(componentSource).not.toMatch(/href=|new URL|encodeURI/);
    });

    it('keeps the flat responsive ledger and every action or summary at 44px',
        () => {
            const css = readFileSync(
                'apps/rallar-black-box/src/recipe-console/history/RetentionPanel.module.css',
                'utf8',
            );
            expect(css.split('\n').length).toBeLessThanOrEqual(300);
            expect(css).toMatch(
                /\.actions button\s*\{[\s\S]*?min-height:\s*44px/,
            );
            expect(css).toMatch(
                /\.disclosure summary,[\s\S]*?\.totalDisclosure summary\s*\{[\s\S]*?display:\s*list-item;[\s\S]*?min-height:\s*44px/,
            );
            expect(css).toContain('overflow-wrap: anywhere');
            expect(css).toMatch(/@media \(max-width:\s*560px\)/);
            expect(css).not.toMatch(/box-shadow|:hover|position:\s*fixed/);
        });
});
