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

import { createBrowserTestStorage } from '../shared-test/browser-test-storage.ts';

import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestState
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { ManualRallarExecutionPanel } from '../../../apps/rallar-black-box/src/legacy/runner/manual/manual-rallar-execution-panel.tsx';
import { ManualRallarInputsPanel } from '../../../apps/rallar-black-box/src/legacy/runner/manual/manual-rallar-inputs-panel.tsx';
import type { ManualRallarWorkbenchOptions } from '../../../apps/rallar-black-box/src/legacy/runner/manual/manual-rallar-workbench-options.ts';
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
    type ManualActionHistoryEntry
} from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import { decodeManualRtcReadinessText } from '../../../apps/rallar-black-box/src/manual-workbench/manual-command-fields.ts';
import { toManualRtcNegativeRecipeText } from '../../../apps/rallar-black-box/src/manual-workbench/manual-rtc-probe-commands.ts';
import { rallarBlackBoxRuntimeStore } from '../../../apps/rallar-black-box/src/runtime-store.ts';
import { validateSchemaAuthoringText } from '../../../apps/rallar-black-box/src/schema-authoring.ts';
import { UI_STORAGE_KEYS } from '../../../apps/rallar-black-box/src/ui-cache/rallar-black-box-ui-storage.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const bootstrap = resolveRallarBlackBoxBootstrapConfig('?provider=simulated', {}, '');

describe('manual workbench submitted command recording', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(
        [
            { action: 'connect', transport: 'realtime', blocked: true },
            { action: 'join', transport: 'realtime', blocked: true },
            { action: 'matrix run', transport: 'ws', blocked: true },
            { action: 'matrix copy', transport: 'ws', blocked: true },
            { action: 'negative copy', transport: 'ws', blocked: true },
            { action: 'connect', transport: 'ws', blocked: false },
            { action: 'join', transport: 'ws', blocked: false },
            { action: 'connect', transport: 'realtime', blocked: true, text: 'null' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '7' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '[]' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"extra":1}' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"minReadyPeers":0}' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"timeoutMs":-1}' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"intervalMs":0.5}' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"timeoutMs":"5000"}' },
            { action: 'connect', transport: 'realtime', blocked: true, text: '{"minReadyPeers":true}' },
            { action: 'connect', transport: 'realtime', blocked: false, text: '' },
            { action: 'configure', transport: 'realtime', blocked: false },
            { action: 'send', transport: 'realtime', blocked: false },
            { action: 'health', transport: 'realtime', blocked: false, effects: ['request ID', 'sequence', 'history', 'selection', 'execution'] },
            { action: 'close', transport: 'realtime', blocked: false, effects: ['request ID', 'sequence', 'history', 'selection', 'execution'] },
            { action: 'reset', transport: 'realtime', blocked: false, effects: ['request ID', 'sequence', 'history', 'selection', 'execution'] },
            { action: 'nack probe', transport: 'realtime', blocked: false, effects: ['sequence', 'history', 'selection', 'execution'] }
        ] as const
    )('guards readiness before effects of $transport $action $text', async (input) => {
        const { action, transport, blocked } = input;
        const values = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            transport,
            groupId: 'desired-room',
            rtcReadinessText: typeof input.text === 'string' ? input.text : '{'
        };
        const rtcReadinessResult = decodeManualRtcReadinessText(values.rtcReadinessText);
        const negativeRecipeText = rtcReadinessResult.fold(
            (error) => error,
            (rtcConnect) => toManualRtcNegativeRecipeText(values, {}, rtcConnect)
        );
        const effects: string[] = [];
        let error: string | undefined;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async () => {
            effects.push('clipboard');
        });
        const actions = new ManualWorkbenchActions(() => ({
            state,
            bootstrap,
            authSession: undefined,
            globalValues: { ...commandCenterGlobalValuesFromState(state, bootstrap), roomId: 'current-room' },
            globalValuesEdited: false,
            onSelectCommand: () => effects.push('selection'),
            onGlobalValueChange: () => effects.push('room'),
            values,
            sequence: 1,
            payloadResult: decodeManualPayloadText('{}'),
            recipeText: '',
            negativeRecipeText,
            lifetime: { active: true },
            setSequence: () => effects.push('sequence'),
            setHistory: () => effects.push('history'),
            setLocalError: (value) => {
                if (typeof value !== 'function') {
                    error = value;
                }
            },
            runManualCommands: async () => {
                effects.push('execution');
            },
            nowMs: () => 123,
            createRequestId: () => {
                effects.push('request ID');
                return 'invalid-readiness';
            },
            rtcReadinessResult
        }));
        if (action === 'matrix run') {
            await actions.runRtcMatrix('realtime');
        }
        else if (action === 'matrix copy') {
            await actions.copyRtcMatrixRecipe();
        }
        else if (action === 'negative copy') {
            await actions.copyNegativeRecipe();
        }
        else if (action === 'nack probe') {
            await actions.runRtcNackProbe();
        }
        else {
            await actions.runManualAction(action);
        }
        expect({ effects, refused: typeof error === 'string' && error.length > 0 }).toEqual(
            blocked
                ? { effects: [], refused: true }
                : { effects: 'effects' in input ? input.effects : ['room', 'request ID', 'sequence', 'history', 'selection', 'execution'], refused: false }
        );
    });

    it('exports the submitted Off and native selections after a later desired Signaling edit', async () => {
        let history: readonly ManualActionHistoryEntry[] = [];
        const submitted: RallarBlackBoxTestCommand[] = [];
        const offValues = {
            ...DEFAULT_MANUAL_WORKBENCH_VALUES,
            rtcCaptureMode: 'off' as const,
            rtcReadinessText: '{"minReadyPeers":1}'
        };
        const nativeValues = {
            ...offValues,
            rtcCaptureMode: 'native' as const,
            rtcReadinessText: '{"intervalMs":75}'
        };
        const signalingValues = {
            ...offValues,
            rtcCaptureMode: 'signaling' as const,
            rtcReadinessText: '{'
        };
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
            createRequestId: () => 'manual-capture-request',
            rtcReadinessResult: decodeManualRtcReadinessText(offValues.rtcReadinessText)
        };

        await new ManualWorkbenchActions(() => input).runManualAction('connect');
        await new ManualWorkbenchActions(() => ({
            ...input,
            values: nativeValues,
            sequence: 3,
            rtcReadinessResult: decodeManualRtcReadinessText(nativeValues.rtcReadinessText)
        })).runManualAction('connect');
        const copied: string[] = [];
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        try {
            await new ManualWorkbenchActions(() => ({
                ...input,
                values: signalingValues,
                recipeText: toManualRecipeText(history),
                rtcReadinessResult: decodeManualRtcReadinessText(signalingValues.rtcReadinessText)
            })).copyRecipeSnippet();

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
            if (!exported.ok) {
                throw new Error('Submitted history did not export a canonical recipe.');
            }
            const commands = (exported.parsed as RallarBlackBoxTestRecipe).commands;
            expect(commands.filter((command) => command.kind === 'rtc.connect').map((command) => command.readiness)).toEqual([
                { minReadyPeers: 1 },
                { intervalMs: 75 }
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
    let options: ManualRallarWorkbenchOptions;
    const copied: string[] = [];
    const submitted: RallarBlackBoxTestCommand[] = [];

    function Harness() {
        model = useManualRallarWorkbench(options);
        return createElement(
            'section',
            {},
            createElement(ManualRallarInputsPanel, { busy: false, model }),
            createElement(ManualRallarExecutionPanel, { state, authSession: options.authSession, busy: false, onSelectCommand: () => undefined, model })
        );
    }

    beforeEach(async () => {
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        copied.length = 0;
        submitted.length = 0;
        options = {
            state,
            bootstrap,
            authSession: undefined,
            globalValues: commandCenterGlobalValuesFromState(state, bootstrap),
            globalValuesEdited: false,
            onSelectCommand: () => undefined,
            onGlobalValueChange: () => undefined
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        vi.spyOn(rallarBlackBoxRuntimeStore, 'runManualCommands').mockImplementation(async (commands) => {
            submitted.push(...commands);
        });
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    async function editText(labelText: string, text: string): Promise<void> {
        const label = [...container.querySelectorAll('label')].find((entry) => entry.querySelector('span')?.textContent === labelText);
        const control = label?.querySelector('input, textarea');
        expect(control, `Editable ${labelText}`).toBeDefined();
        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
            throw new Error(`Missing editable ${labelText}`);
        }
        expect(control.disabled).toBe(false);
        expect(control.readOnly).toBe(false);
        const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        await act(async () => {
            Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, text);
            control.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    async function clickAction(text: string): Promise<void> {
        const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent === text);
        expect(button, `Manual action ${text}`).toBeInstanceOf(HTMLButtonElement);
        await act(async () => button?.click());
    }

    async function restoreDraft(rtcReadinessText: string): Promise<void> {
        await act(async () => root.render(null));
        window.localStorage.setItem(
            UI_STORAGE_KEYS.manualDraft,
            JSON.stringify({
                values: { ...DEFAULT_MANUAL_WORKBENCH_VALUES, rtcReadinessText, rtcCaptureMode: 'native' },
                payloadPresetId: 'custom',
                payloadText: '{}'
            })
        );
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
    }

    it('renders an editable RTC readiness JSON control alongside actual Manual actions', () => {
        const label = [...container.querySelectorAll('label')].find((entry) => entry.querySelector('span')?.textContent === 'RTC readiness JSON');
        expect(label?.querySelector('textarea')).toBeInstanceOf(HTMLTextAreaElement);
    });

    it('submits omitted readiness through the rendered Connect action and copies that submitted history', async () => {
        await editText('Group', 'rendered-room');
        const connect = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect');
        expect(connect).toBeInstanceOf(HTMLButtonElement);
        await act(async () => connect?.click());
        expect(submitted).toMatchObject([{ kind: 'rtc.connect', roomId: 'rendered-room' }]);
        expect(submitted[0]).not.toHaveProperty('readiness');
        const copy = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy Recipe');
        await act(async () => copy?.click());
        expect(copied).toHaveLength(1);
        expect(validateSchemaAuthoringText('recipe', copied[0]).parsed).toMatchObject({ commands: [{ kind: 'rtc.connect' }] });
    });

    it.each(['Connect', 'Create and join group'])('conserves edited readiness through rendered %s and later desired edits', async (action) => {
        await editText('RTC readiness JSON', '{"minReadyPeers":1,"timeoutMs":5000,"intervalMs":100}');
        await clickAction(action);
        await editText('RTC readiness JSON', '{"intervalMs":75}');
        await clickAction('Copy Recipe');
        await editText('RTC readiness JSON', '{');
        await clickAction('Copy Recipe');
        const connects = submitted.filter((command) => command.kind === 'rtc.connect');
        expect(connects.map((command) => command.readiness)).toEqual([{ minReadyPeers: 1, timeoutMs: 5000, intervalMs: 100 }]);
        expect(copied).toHaveLength(2);
        expect(copied[1]).toBe(copied[0]);
        expect(validateSchemaAuthoringText('recipe', copied[0]).parsed).toMatchObject({
            commands: expect.arrayContaining([
                expect.objectContaining({ kind: 'rtc.connect', readiness: { minReadyPeers: 1, timeoutMs: 5000, intervalMs: 100 } })
            ])
        });
    });

    it('keeps malformed restored text visible and guards a retained Connect independently of disabled buttons', async () => {
        await restoreDraft('{');
        const retained = model.runManualAction;
        await act(async () => retained('connect'));
        expect(submitted).toEqual([]);
        expect(model.localError).toEqual(expect.any(String));
        const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent === 'Connect');
        expect(button?.disabled).toBe(true);
        const label = [...container.querySelectorAll('label')].find((entry) => entry.querySelector('span')?.textContent === 'RTC readiness JSON');
        expect(label?.querySelector('textarea')?.value).toBe('{');
        expect(model.history).toEqual([]);
    });

    it('refuses a retained unsubmitted Connect after a valid draft becomes malformed', async () => {
        await editText('RTC readiness JSON', '{"intervalMs":75}');
        const retained = model.runManualAction;
        await editText('RTC readiness JSON', '{');
        await act(async () => retained('connect'));
        expect(submitted).toEqual([]);
        expect(model.history).toEqual([]);
        expect(model.localError).toEqual(expect.any(String));
    });

    it('preserves readiness independently of auth and edited global scope', async () => {
        await restoreDraft('{"intervalMs":75}');
        options = {
            ...options,
            authSession: {
                clientId: 'signed-in-client',
                username: 'signed-in-user',
                sessionId: 'signed-in-session',
                accessToken: 'test-auth-token',
                expiresAtEpochMs: 1000
            },
            globalValuesEdited: true,
            globalValues: {
                ...options.globalValues,
                clientId: 'global-client',
                sessionId: 'global-session',
                applicationId: 'global-app',
                workspaceId: 'global-workspace',
                roomId: 'global-room'
            }
        };
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
        expect(model.values).toMatchObject({
            actor: 'global-client',
            sessionId: 'global-session',
            applicationId: 'global-app',
            workspaceId: 'global-workspace',
            groupId: 'global-room',
            rtcCaptureMode: 'native'
        });
        expect(model.values).toMatchObject({ rtcReadinessText: '{"intervalMs":75}' });
    });

    it('persists blank readiness after Reset and remounts with omitted next-Connect capture and readiness', async () => {
        await restoreDraft('{"intervalMs":75}');
        window.localStorage.setItem(UI_STORAGE_KEYS.activeTab, 'rallar-server');
        window.localStorage.setItem(UI_STORAGE_KEYS.activeMode, 'black-box-runner');
        await clickAction('Reset runtime');
        const saved: unknown = JSON.parse(window.localStorage.getItem(UI_STORAGE_KEYS.manualDraft) ?? '{}');
        await act(async () => root.render(null));
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
        expect(model.history).toEqual([]);
        submitted.length = 0;
        await clickAction('Connect');
        const connect = submitted.find((command) => command.kind === 'rtc.connect');
        expect(connect).not.toHaveProperty('readiness');
        expect(connect?.rallar).not.toHaveProperty('rtcCaptureMode');
        expect(window.localStorage.getItem(UI_STORAGE_KEYS.activeTab)).toBe('rallar-server');
        expect(window.localStorage.getItem(UI_STORAGE_KEYS.activeMode)).toBe('black-box-runner');
        expect(saved).toMatchObject({ values: { rtcReadinessText: '' } });
    });

    it('copies only the last twelve submitted actions and does not persist their history', async () => {
        for (let index = 0; index < 13; index++) {
            await clickAction('Health check');
        }
        expect(model.history).toHaveLength(12);
        await clickAction('Copy Recipe');
        const exported = validateSchemaAuthoringText('recipe', copied[0]);
        expect(exported.ok).toBe(true);
        if (!exported.ok) {
            throw new Error('Submitted history did not export a canonical recipe.');
        }
        const commands = (exported.parsed as RallarBlackBoxTestRecipe).commands;
        expect(commands).toHaveLength(12);
        expect(commands).toEqual(submitted.slice(1));
        await act(async () => root.render(null));
        await act(async () => root.render(createElement(StrictMode, {}, createElement(Harness))));
        expect(model.history).toEqual([]);
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
