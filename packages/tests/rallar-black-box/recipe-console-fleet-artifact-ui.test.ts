// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeConsoleControlFleetCapability } from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { RecipeConsoleControlFleetApi } from '../../../apps/rallar-black-box/src/recipe-console/control/control-fleet-api.ts';
import { createFleetArtifactDownload } from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-artifact-download.ts';
import { deriveFleetArtifactModel } from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-artifact-model.ts';
import { FleetArtifactEvidence } from '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetArtifactEvidence.tsx';
import type { ControlFleetReportBundle } from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

function bundle(distributedRunId: string): ControlFleetReportBundle {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        generatedAtEpochMs: 2_000,
        files: {
            'fleet-report.json': '{"ok":true}',
            'summary.md': '# Résumé 🛰️',
            'agent-results.csv': 'agentId,state\na,passed\n',
            'failure-signatures.csv': 'signatureId,count\n'
        }
    };
}

describe('Recipe Console Fleet artifact model', () => {
    it('projects exactly four UTF-8 file identities and one validated envelope', () => {
        const value = bundle('run-\u202e/unsafe');
        const model = deriveFleetArtifactModel(value);

        expect(model.files.map((file) => file.name)).toEqual([
            'fleet-report.json',
            'summary.md',
            'agent-results.csv',
            'failure-signatures.csv'
        ]);
        expect(model.files.map((file) => file.utf8Bytes)).toEqual(
            model.files.map((file) => new TextEncoder().encode(file.content).byteLength)
        );
        expect(model.totalUtf8Bytes).toBe(model.files.reduce(
            (total, file) => total + file.utf8Bytes,
            0
        ));
        const download = createFleetArtifactDownload(value);
        expect(download.mediaType).toBe('application/json');
        expect(download.filename).toMatch(/-fleet-report-bundle\.json$/);
        expect(download.filename).not.toMatch(/[\x00-\x1f\x7f/\\\u202a-\u202e]/u);
        expect(JSON.parse(download.content)).toEqual(value);
    });
});

describe('Recipe Console Fleet artifact evidence', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot> | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
        vi.restoreAllMocks();
    });

    it('loads only on click, exports exact evidence, and clears on report change and unmount', async () => {
        const clear = vi.fn();
        const select = vi.fn(async ({ distributedRunId }: {
            distributedRunId: string;
            signal?: AbortSignal;
        }) => bundle(distributedRunId));
        const api = {
            selectReportBundle: select,
            getSelectedReportBundle: vi.fn(),
            clearSelectedReportBundle: clear
        } as RecipeConsoleControlFleetApi;
        const load = vi.fn(async () => api);
        const capability = {
            generation: Symbol('fleet-test'),
            signal: new AbortController().signal,
            load
        } as RecipeConsoleControlFleetCapability;
        const downloads: Array<Readonly<{ filename: string; href: string; }>> = [];
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fleet-export');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            downloads.push({ filename: this.download, href: this.href });
        });
        root = createRoot(container);

        await act(async () =>
            root?.render(createElement(FleetArtifactEvidence, {
                capability,
                selectedReportId: 'run-a'
            }))
        );
        expect(load).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
        const loadButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === 'Load artifact bundle');
        await act(async () => loadButton?.click());

        expect(load).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledWith(expect.objectContaining({
            distributedRunId: 'run-a',
            signal: expect.any(AbortSignal)
        }));
        expect(container.textContent).toContain('fleet-report.json');
        expect(container.textContent).toContain('summary.md');
        expect(container.textContent).toContain('agent-results.csv');
        expect(container.textContent).toContain('failure-signatures.csv');
        const exportButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === 'Export validated envelope');
        await act(async () => exportButton?.click());
        expect(downloads).toEqual([{
            filename: 'run-a-fleet-report-bundle.json',
            href: 'blob:fleet-export'
        }]);

        await act(async () =>
            root?.render(createElement(FleetArtifactEvidence, {
                capability,
                selectedReportId: 'run-b'
            }))
        );
        expect(clear).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledTimes(1);
        expect(container.textContent).not.toContain('fleet-report.json');

        await act(async () => root?.unmount());
        root = undefined;
        expect(clear).toHaveBeenCalledTimes(2);
    });

    it('aborts pending selection when the exact report changes', async () => {
        let observedSignal: AbortSignal | undefined;
        const api = {
            selectReportBundle: vi.fn(({ signal }: { signal?: AbortSignal; }) => {
                observedSignal = signal;
                return new Promise<ControlFleetReportBundle>(() => undefined);
            }),
            getSelectedReportBundle: vi.fn(),
            clearSelectedReportBundle: vi.fn()
        } as RecipeConsoleControlFleetApi;
        const capability = {
            generation: Symbol('fleet-pending'),
            signal: new AbortController().signal,
            load: vi.fn(async () => api)
        } as RecipeConsoleControlFleetCapability;
        root = createRoot(container);
        await act(async () =>
            root?.render(createElement(FleetArtifactEvidence, {
                capability,
                selectedReportId: 'run-a'
            }))
        );
        const loadButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === 'Load artifact bundle');
        await act(async () => loadButton?.click());
        expect(observedSignal?.aborted).toBe(false);

        await act(async () =>
            root?.render(createElement(FleetArtifactEvidence, {
                capability,
                selectedReportId: 'run-b'
            }))
        );
        expect(observedSignal?.aborted).toBe(true);
        expect(api.clearSelectedReportBundle).toHaveBeenCalledTimes(1);
    });

    it('keeps exact last-usable evidence visible when a same-report retry fails', async () => {
        const select = vi.fn()
            .mockResolvedValueOnce(bundle('run-a'))
            .mockRejectedValueOnce(new Error('Retry bundle is malformed.'));
        const api = {
            selectReportBundle: select,
            getSelectedReportBundle: vi.fn(),
            clearSelectedReportBundle: vi.fn()
        } as RecipeConsoleControlFleetApi;
        const capability = {
            generation: Symbol('fleet-retry'),
            signal: new AbortController().signal,
            load: vi.fn(async () => api)
        } as RecipeConsoleControlFleetCapability;
        root = createRoot(container);
        await act(async () =>
            root?.render(createElement(FleetArtifactEvidence, {
                capability,
                selectedReportId: 'run-a'
            }))
        );
        const loadButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === 'Load artifact bundle');
        await act(async () => loadButton?.click());
        expect(container.textContent).toContain('fleet-report.json');

        await act(async () => loadButton?.click());

        expect(select).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')?.textContent)
            .toContain('Retry bundle is malformed');
        expect(container.textContent).toContain('fleet-report.json');
        expect(container.textContent).toContain('Export validated envelope');
    });
});
