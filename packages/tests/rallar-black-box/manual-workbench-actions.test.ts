// @vitest-environment happy-dom
import {
    act,
    createElement,
    StrictMode
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestState
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { RtcSignalingDiagnostics } from '../../shared/webrtc/rtc-signaling-diagnostics.ts';

import { ManualWorkbenchActions } from '../../../apps/rallar-black-box/src/legacy/runner/manual/manual-workbench-actions.ts';
import {
    useManualRallarWorkbench,
    type ManualRallarWorkbenchModel
} from '../../../apps/rallar-black-box/src/legacy/runner/manual/use-manual-rallar-workbench.ts';
import { commandCenterGlobalValuesFromState } from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';
import {
    decodeManualPayloadText,
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    toManualRecipeText,
    type ManualActionHistoryEntry,
    type ManualWorkbenchValues
} from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import { validateSchemaAuthoringText } from '../../../apps/rallar-black-box/src/schema-authoring.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const bootstrap = resolveRallarBlackBoxBootstrapConfig('?provider=simulated', {}, '');

describe('manual workbench submitted command recording', () => {
    it('exports the submitted Off and native selections after a later desired Signaling edit', async () => {
        let history: readonly ManualActionHistoryEntry[] = [];
        const submitted: RallarBlackBoxTestCommand[] = [];
        const offValues = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            rtcCaptureMode: 'off'
        } satisfies ManualWorkbenchValues & { readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode; };
        const nativeValues = {
            ...offValues,
            rtcCaptureMode: 'native'
        } satisfies ManualWorkbenchValues & { readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode; };
        const signalingValues = {
            ...offValues,
            rtcCaptureMode: 'signaling'
        } satisfies ManualWorkbenchValues & { readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode; };
        const input: ManualWorkbenchActions.Input = {
            state,
            bootstrap,
            authSession: undefined,
            globalValues: commandCenterGlobalValuesFromState(state, bootstrap),
            globalValuesEdited: false,
            onSelectCommand: () => undefined,
            onGlobalValueChange: () => undefined,
            values: offValues,
            sequence: 1,
            payloadResult: decodeManualPayloadText('{}'),
            recipeText: '',
            negativeRecipeText: '',
            lifetime: { active: true },
            setSequence: () => undefined,
            setHistory: (update) => {
                history = typeof update === 'function' ? update(history) : update;
            },
            setLocalError: () => undefined,
            runManualCommands: async (commands) => {
                submitted.push(...commands);
            },
            nowMs: () => 123,
            createRequestId: () => 'manual-capture-request'
        };

        await new ManualWorkbenchActions(input).runManualAction('connect');
        await new ManualWorkbenchActions({ ...input, values: nativeValues, sequence: 3 }).runManualAction('connect');
        const copied: string[] = [];
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        try {
            await new ManualWorkbenchActions({
                ...input,
                values: signalingValues,
                recipeText: toManualRecipeText(history)
            }).copyRecipeSnippet();

            expect(copied).toHaveLength(1);
            const exported = validateSchemaAuthoringText('recipe', copied[0]);
            expect(exported.ok).toBe(true);
            expect(exported.parsed).toMatchObject({
                commands: [
                    { commandId: 'manual-rtc-connect-1', rallar: { rtcCaptureMode: 'off' } },
                    { commandId: 'manual-rtc-connect-3', rallar: { rtcCaptureMode: 'native' } }
                ]
            });
            expect(submitted).toMatchObject([
                { kind: 'rtc.connect', rallar: { rtcCaptureMode: 'off' } },
                { kind: 'rtc.connect', rallar: { rtcCaptureMode: 'native' } }
            ]);
        }
        finally {
            clipboard.mockRestore();
        }
    });
});

describe('manual workbench public copy actions', () => {
    let root: Root;
    let container: HTMLDivElement;
    let model: ManualRallarWorkbenchModel;
    const copied: string[] = [];

    function Harness() {
        model = useManualRallarWorkbench({
            state,
            bootstrap,
            authSession: undefined,
            globalValues: commandCenterGlobalValuesFromState(state, bootstrap),
            globalValuesEdited: false,
            onSelectCommand: () => undefined,
            onGlobalValueChange: () => undefined
        });
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
