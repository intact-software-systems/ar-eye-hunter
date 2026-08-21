// @vitest-environment happy-dom
import { createElement, isValidElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TuneInspection } from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-inspection.ts';
import type { TuneSourceModel } from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-model.ts';
import { TuneInspector } from '../../../apps/rallar-black-box/src/recipe-console/tune/TuneInspector.tsx';
import { useTuneInspectionHost } from '../../../apps/rallar-black-box/src/recipe-console/tune/use-tune-inspection-host.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

function tuneSource(focusRunId: string): TuneSourceModel {
    return {
        focusRunId,
        identity: { quarantined: false }
    } as unknown as TuneSourceModel;
}

describe('useTuneInspectionHost', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

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
    });

    it('synchronizes scoped inspector content and clears it across authority changes and unmount', async () => {
        const sourceA = tuneSource('distributed-a');
        const sourceB = tuneSource('distributed-b');
        const contentChanges: Array<ReactNode | undefined> = [];
        const labelChanges: Array<string | undefined> = [];
        const triggers: HTMLButtonElement[] = [];
        const onInspect = (trigger: HTMLButtonElement) => {
            triggers.push(trigger);
        };
        const onInspectorChange = (content: ReactNode | undefined) => {
            contentChanges.push(content);
        };
        const onSelectionLabelChange = (label: string | undefined) => {
            labelChanges.push(label);
        };
        let inspect:
            | ((
                selection: TuneInspection,
                trigger: HTMLButtonElement
            ) => void)
            | undefined;

        function Harness({ source }: Readonly<{ source: TuneSourceModel; }>) {
            inspect = useTuneInspectionHost({
                source,
                onInspect,
                onInspectorChange,
                onSelectionLabelChange
            });
            return null;
        }

        root = createRoot(container);
        await act(async () =>
            root?.render(createElement(Harness, {
                source: sourceA
            }))
        );
        expect(contentChanges).toEqual([undefined]);
        expect(labelChanges).toEqual([undefined]);

        const triggerA = document.createElement('button');
        const selectionA: TuneInspection = {
            kind: 'agent',
            agentId: 'agent-a',
            channel: 'command'
        };
        await act(async () => inspect?.(selectionA, triggerA));

        const contentA = contentChanges.at(-1);
        expect(triggers).toEqual([triggerA]);
        expect(isValidElement<{
            selection: TuneInspection;
            source: TuneSourceModel;
        }>(contentA)).toBe(true);
        if (
            !isValidElement<{
                selection: TuneInspection;
                source: TuneSourceModel;
            }>(contentA)
        ) {
            throw new Error('Expected TuneInspector content.');
        }
        expect(contentA.type).toBe(TuneInspector);
        expect(contentA.props).toEqual({
            selection: selectionA,
            source: sourceA
        });
        expect(labelChanges.at(-1)).toBe('Agent · agent-a');

        await act(async () =>
            root?.render(createElement(Harness, {
                source: sourceB
            }))
        );
        expect(contentChanges.at(-1)).toBeUndefined();
        expect(labelChanges.at(-1)).toBeUndefined();

        await act(async () =>
            root?.render(createElement(Harness, {
                source: sourceA
            }))
        );
        expect(contentChanges.at(-1)).toBeUndefined();
        expect(labelChanges.at(-1)).toBeUndefined();

        const triggerB = document.createElement('button');
        await act(async () =>
            inspect?.({
                kind: 'knob',
                pointer: '/recipes/0/retryMs'
            }, triggerB)
        );
        expect(triggers).toEqual([triggerA, triggerB]);
        expect(labelChanges.at(-1)).toBe('Knob · /recipes/0/retryMs');

        await act(async () => root?.unmount());
        root = undefined;
        expect(contentChanges.at(-1)).toBeUndefined();
        expect(labelChanges.at(-1)).toBeUndefined();
    });
});
