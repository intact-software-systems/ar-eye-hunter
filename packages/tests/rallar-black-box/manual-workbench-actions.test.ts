// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useManualRallarWorkbench,
    type ManualRallarWorkbenchModel
} from '../../../apps/rallar-black-box/src/legacy/runner/manual/use-manual-rallar-workbench.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const bootstrap = resolveRallarBlackBoxBootstrapConfig('?provider=simulated', {}, '');

describe('manual workbench public copy actions', () => {
    let root: Root;
    let container: HTMLDivElement;
    let model: ManualRallarWorkbenchModel;
    const copied: string[] = [];

    function Harness() {
        model = useManualRallarWorkbench({ state, bootstrap, onSelectCommand: () => undefined });
        return null;
    }

    beforeEach(async () => {
        window.localStorage?.clear();
        copied.length = 0;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it.each(['copyRtcMatrixRecipe', 'copyNegativeRecipe'] as const)('publishes a complete canonical recipe through %s', async (action) => {
        await act(async () => model[action]());
        expect(copied).toHaveLength(1);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, JSON.parse(copied[0]))).toMatchObject({ ok: true });
        expect(model.previewRecipeValidation?.ok).toBe(true);
    });

    it.each(['copyRecipeSnippet', 'copyRtcMatrixRecipe', 'copyNegativeRecipe'] as const)('reports unavailable clipboard through %s', async (action) => {
        vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => Reflect.get({}, 'clipboard'));
        await act(async () => model[action]());
        expect(model.localError).toMatch(/clipboard.*unavailable/i);
    });

    it('reports a rejected copy without an unhandled promise', async () => {
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
        await act(async () => model.copyNegativeRecipe());
        expect(model.localError).toMatch(/unable to copy/i);
    });

    it('prevents retained actions from copying after unmount', async () => {
        const copy = model.copyNegativeRecipe;
        await act(async () => root.render(null));
        await act(async () => copy());
        expect(copied).toEqual([]);
    });
});
