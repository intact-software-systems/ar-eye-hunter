// @vitest-environment happy-dom
import type { DistributedRunPerformanceAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuneCommandTiming } from '../../../apps/rallar-black-box/src/recipe-console/tune/TuneCommandTiming.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

function performanceWithCommandTiming(
    commandTiming: DistributedRunPerformanceAnalysis['commandTiming']
): DistributedRunPerformanceAnalysis {
    return {
        commandTiming,
        slowestAgents: [],
        streamTiming: { duration: {}, slowestAgents: [] },
        receiverDelivery: { lowestReceivers: [] }
    } as unknown as DistributedRunPerformanceAnalysis;
}

describe('TuneCommandTiming sample count', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        await act(async () => {
            root?.unmount();
        });
        root = undefined;
        container.remove();
    });

    async function renderTiming(
        performance: DistributedRunPerformanceAnalysis | undefined
    ): Promise<string> {
        await act(async () => {
            root = createRoot(container);
            root.render(createElement(TuneCommandTiming, {
                performance,
                onInspect: () => {}
            }));
        });
        return container.querySelector('header span')?.textContent ?? '';
    }

    it('reports a recorded zero-sample summary as zero samples', async () => {
        expect(
            await renderTiming(performanceWithCommandTiming({ count: 0 }))
        ).toBe('0 samples');
    });

    it('reports a recorded sample count exactly', async () => {
        expect(
            await renderTiming(performanceWithCommandTiming({ count: 12, p50Ms: 4 }))
        ).toBe('12 samples');
    });

    it('reports a summary that omits its count as unknown, not as zero', async () => {
        expect(
            await renderTiming(performanceWithCommandTiming({ p50Ms: 4 }))
        ).toBe('Samples unknown');
    });

    it('reports an absent performance section as unknown, not as zero', async () => {
        expect(await renderTiming(undefined)).toBe('Samples unknown');
    });
});
