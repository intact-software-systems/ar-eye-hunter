// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionConfirmDialog } from
    '../../../apps/rallar-black-box/src/recipe-console/history/RetentionConfirmDialog.tsx';
import type { RetentionCleanupPreview } from
    '../../../apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW: RetentionCleanupPreview = {
    current: true,
    retainedRuns: 4,
    maxRuns: 2,
    projectedRetainedRuns: 2,
    candidates: [{
        key: 'retention-candidate:0',
        runId: 'control-delete-exact',
        createdAtEpochMs: 100,
        updatedAtEpochMs: 200,
        connectedAgentCount: 2,
        issuedRunTokenCount: 3,
        distributedRuns: [{
            distributedRunId: 'distributed-delete-exact',
            state: 'failed',
        }],
        fleetReportIds: ['fleet-delete-exact'],
    }],
    wouldDeleteRunIds: ['control-delete-exact'],
    wouldDeleteDistributedRunIds: ['distributed-delete-exact'],
    wouldDeleteFleetReportIds: ['fleet-delete-exact'],
    preserves: {
        connectedAgentSockets: true,
        storedArtifactFiles: true,
    },
};

describe('RetentionConfirmDialog', () => {
    let container: HTMLDivElement;
    let restoreFocus: HTMLButtonElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        restoreFocus = document.createElement('button');
        restoreFocus.textContent = 'Preview retention';
        document.body.append(restoreFocus, container);
        restoreFocus.focus();
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        restoreFocus.remove();
    });

    async function render(input: Readonly<{
        open?: boolean;
        preview?: RetentionCleanupPreview;
        busy?: boolean;
        message?: string;
        onCancel?: () => void;
        onConfirm?: () => void;
    }> = {}) {
        const onCancel = input.onCancel ?? vi.fn();
        const onConfirm = input.onConfirm ?? vi.fn();
        await act(async () => root.render(createElement(RetentionConfirmDialog, {
            open: input.open ?? true,
            preview: input.preview ?? PREVIEW,
            busy: input.busy ?? false,
            message: input.message,
            restoreFocus,
            onCancel,
            onConfirm,
        })));
        return { onCancel, onConfirm };
    }

    it('opens an exact token-free alertdialog with non-destructive initial focus', async () => {
        await render();
        const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]');
        const keep = button('Keep history');
        const confirm = button('Delete previewed runs');

        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(document.activeElement).toBe(keep);
        expect(dialog?.textContent).toContain('control-delete-exact');
        expect(dialog?.textContent).toContain('4 current runs');
        expect(dialog?.textContent).toContain('2 projected runs');
        expect(dialog?.textContent).toContain('1 control run');
        expect(confirm.disabled).toBe(false);
        expect(container.innerHTML).not.toContain('planToken');
    });

    it('wraps Tab and Shift+Tab inside the dialog', async () => {
        await render();
        const keep = button('Keep history');
        const confirm = button('Delete previewed runs');

        await key(keep, 'Tab', true);
        expect(document.activeElement).toBe(confirm);
        await key(confirm, 'Tab');
        expect(document.activeElement).toBe(keep);
    });

    it('cancels with Escape or backdrop and restores focus when closed', async () => {
        const onCancel = vi.fn();
        await render({ onCancel });
        await key(button('Keep history'), 'Escape');
        expect(onCancel).toHaveBeenCalledTimes(1);

        onCancel.mockClear();
        const backdrop = container.querySelector<HTMLElement>(
            '[data-retention-confirm-dialog]',
        );
        await act(async () => backdrop?.click());
        expect(onCancel).toHaveBeenCalledTimes(1);

        await render({ open: false, onCancel });
        expect(document.activeElement).toBe(restoreFocus);
    });

    it('guards duplicate confirmation and blocks every exit while busy', async () => {
        const onCancel = vi.fn();
        const onConfirm = vi.fn();
        await render({ onCancel, onConfirm });
        await act(async () => {
            button('Delete previewed runs').click();
            button('Delete previewed runs').click();
        });
        expect(onConfirm).toHaveBeenCalledTimes(1);

        await render({ busy: true, message: 'Deleting previewed runs…', onCancel,
            onConfirm });
        const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]');
        expect(document.activeElement).toBe(dialog);
        expect(container.querySelector('[aria-live="assertive"]')?.textContent)
            .toContain('Deleting previewed runs…');
        await key(dialog!, 'Escape');
        await act(async () => container.querySelector<HTMLElement>(
            '[data-retention-confirm-dialog]',
        )?.click());
        expect(onCancel).not.toHaveBeenCalled();
        expect(button('Keep history').disabled).toBe(true);
        expect(button('Delete previewed runs').disabled).toBe(true);
    });

    it('keeps stale preview consequences visible but nonconfirmable', async () => {
        await render({
            preview: { ...PREVIEW, current: false },
            message: 'Preview is stale; preview again.',
        });

        expect(container.textContent).toContain('Preview is stale; preview again.');
        expect(container.textContent).toContain('control-delete-exact');
        expect(button('Delete previewed runs').disabled).toBe(true);
    });

    it('disables dialog motion under reduced motion and contains mobile overflow', () => {
        const css = readFileSync(resolve(
            process.cwd(),
            'apps/rallar-black-box/src/recipe-console/history/RetentionConfirmDialog.module.css',
        ), 'utf8');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toMatch(/animation:\s*none/);
        expect(css).toMatch(/max-height:\s*calc\(100dvh/);
        expect(css).toContain('overflow: auto');
        expect(css).toContain('min-height: 44px');
    });

    function button(text: string): HTMLButtonElement {
        const match = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(candidate => candidate.textContent === text);
        if (!match) throw new Error(`Missing button ${text}`);
        return match;
    }
});

async function key(target: HTMLElement, keyValue: string, shiftKey = false) {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
        key: keyValue,
        shiftKey,
        bubbles: true,
        cancelable: true,
    })));
}
