// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzeArtifactProjection } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-projection-contract.ts';
import { AnalyzeInspector } from '../../../apps/rallar-black-box/src/recipe-console/analyze/AnalyzeInspector.tsx';
import type { DistributedArtifactEvidenceEntry } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-contracts.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL = { workspace: { source: 'loose-files', support: 'supported' } } as AnalyzeArtifactProjection;

describe('Recipe Console Analyze inspector summaries', () => {
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

    it('heads an event identity list as the identity summary', async () => {
        await render(entry({ kind: 'event', identitySummary: 'kind=event topic=room.telemetry' }));

        expect(headings()).toEqual(['Identity summary']);
        expect(container.textContent).toContain('kind=event topic=room.telemetry');
    });

    it('heads a failure next action and a passed result value as detail', async () => {
        await render(entry({ kind: 'failure', detailSummary: 'RTC_NO_ROUTE · Check TURN' }));
        expect(headings()).toEqual(['Detail']);
        expect(container.textContent).toContain('RTC_NO_ROUTE · Check TURN');

        await render(entry({ kind: 'result', detailSummary: '{"received":0}' }));
        expect(headings()).toEqual(['Detail']);
    });

    it('keeps a failed result detail in the collapsed raw disclosure', async () => {
        await render(entry({
            kind: 'result',
            detailSummary: '{"name":"RALLAR_BLACK_BOX_TIMEOUT"}',
            failureDetails: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED' }
        }));

        expect(headings()).toEqual([]);
        expect(container.querySelector('details summary')?.textContent).toBe('Raw payload JSON');
        expect(container.querySelector('details pre')?.textContent).toBe('{"name":"RALLAR_BLACK_BOX_TIMEOUT"}');
    });

    async function render(selected: DistributedArtifactEvidenceEntry): Promise<void> {
        await act(async () => root.render(createElement(AnalyzeInspector, { entry: selected, model: MODEL })));
    }

    function headings(): readonly string[] {
        return [...container.querySelectorAll('h3')].map((heading) => heading.textContent ?? '');
    }
});

function entry(
    fields: Pick<DistributedArtifactEvidenceEntry, 'kind'> & Partial<DistributedArtifactEvidenceEntry>
): DistributedArtifactEvidenceEntry {
    return {
        id: `evidence-${fields.kind}`,
        sourceFile: 'events.jsonl',
        summary: `Selected ${fields.kind}`,
        ...fields
    };
}
