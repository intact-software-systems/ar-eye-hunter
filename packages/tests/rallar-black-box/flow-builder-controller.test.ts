// @vitest-environment happy-dom
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FLOW_BUILDER_TEMPLATES,
    toTemplateFlowBuilderText
} from '../../../apps/rallar-black-box/src/flow-builder/flow-builder-templates.ts';
import {
    useFlowBuilderController,
    type FlowBuilderControllerModel,
    type UseFlowBuilderControllerInput
} from '../../../apps/rallar-black-box/src/legacy/runner/builder/use-flow-builder-controller.ts';
import type { CommandCenterGlobalValues } from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';

interface RecordedRun {
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly label: string;
}

const runs = vi.hoisted(() => [] as RecordedRun[]);
const runFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: {
        executeManualCommands: async (commands: readonly RallarBlackBoxTestCommand[], label: string) => {
            runs.push({ commands, label });
            if (runFailure.error) {
                throw runFailure.error;
            }
        }
    }
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const globalValues: CommandCenterGlobalValues = {
    apiBaseUrl: 'https://api.example.test',
    applicationId: 'primary-application',
    workspaceId: 'primary-workspace',
    clientId: 'primary-client',
    sessionId: 'primary-session',
    roomId: 'primary-room'
};

function FlowBuilderHarness(props: { input: UseFlowBuilderControllerInput; capture(view: FlowBuilderControllerModel): void; }) {
    const view = useFlowBuilderController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

const CLIPBOARD_FAILURES = [
    {
        name: 'an unavailable clipboard',
        arrange: () => vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => Reflect.get({}, 'clipboard')),
        error: 'Clipboard access is unavailable in this browser.'
    },
    {
        name: 'a rejected copy',
        arrange: () => vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied')),
        error: 'Unable to copy to the clipboard. Check browser permissions and try again.'
    }
];

describe('flow builder controller preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    let view: FlowBuilderControllerModel;
    const selected: string[] = [];

    async function render(next: Partial<UseFlowBuilderControllerInput> = {}): Promise<void> {
        const input: UseFlowBuilderControllerInput = {
            state,
            authSession: undefined,
            globalValues,
            onSelectCommand: (commandId) => selected.push(commandId),
            ...next
        };
        await act(async () =>
            root.render(createElement(
                StrictMode,
                null,
                createElement(FlowBuilderHarness, {
                    input,
                    capture: (captured) => {
                        view = captured;
                    }
                })
            ))
        );
    }

    function globalVariables(values: CommandCenterGlobalValues, templateIndex: number): RallarBlackBoxTestRecord {
        return {
            ...FLOW_BUILDER_TEMPLATES[templateIndex].flow.variables,
            apiBaseUrl: values.apiBaseUrl,
            applicationId: values.applicationId,
            workspaceId: values.workspaceId,
            groupId: values.roomId,
            actor: values.clientId,
            sessionId: values.sessionId,
            username: values.clientId
        };
    }

    beforeEach(() => {
        runs.length = 0;
        selected.length = 0;
        runFailure.error = undefined;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it('starts from the first template with global variables and a valid recipe and runner scenario', async () => {
        await render();

        expect({
            templateId: view.templateId,
            flowText: view.flowText,
            variables: JSON.parse(view.variablesText),
            flowId: view.flow?.flowId,
            recipeId: view.recipe?.recipeId,
            runnerSteps: view.runnerScenario?.steps.length,
            parseError: view.parseError,
            recipeText: JSON.parse(view.recipeText).recipeId === view.recipe?.recipeId,
            runnerTextIsScenario: JSON.parse(view.runnerText).connections !== undefined,
            recipeValid: view.recipeValidation?.ok,
            runnerValid: view.runnerValidation?.ok,
            localError: view.localError
        }).toEqual({
            templateId: FLOW_BUILDER_TEMPLATES[0].templateId,
            flowText: toTemplateFlowBuilderText(FLOW_BUILDER_TEMPLATES[0].templateId),
            variables: globalVariables(globalValues, 0),
            flowId: FLOW_BUILDER_TEMPLATES[0].flow.flowId,
            recipeId: FLOW_BUILDER_TEMPLATES[0].flow.flowId,
            runnerSteps: expect.any(Number),
            parseError: undefined,
            recipeText: true,
            runnerTextIsScenario: true,
            recipeValid: true,
            runnerValid: true,
            localError: undefined
        });
    });

    it.each([
        { name: 'invalid flow JSON', flowText: '{', variablesText: '{}', error: 'JSON' },
        { name: 'a flow without steps', flowText: '{"flowId":"f","name":"n"}', variablesText: '{}', error: 'Flow JSON requires flowId, name, and steps.' },
        { name: 'array variables', flowText: undefined, variablesText: '[]', error: 'Variables JSON must be an object.' }
    ])('reports $name as the parse error instead of a recipe', async ({ flowText, variablesText, error }) => {
        await render();
        await act(async () => {
            if (flowText !== undefined) {
                view.setFlowText(flowText);
            }
            view.setVariablesText(variablesText);
        });

        expect({
            parseError: view.parseError?.includes(error),
            recipe: view.recipe,
            runnerScenario: view.runnerScenario,
            recipeText: view.recipeText === view.parseError,
            runnerText: view.runnerText === view.recipeText,
            recipeValidation: view.recipeValidation,
            flow: flowText === undefined ? view.flow?.flowId : view.flow
        }).toEqual({
            parseError: true,
            recipe: undefined,
            runnerScenario: undefined,
            recipeText: true,
            runnerText: true,
            recipeValidation: undefined,
            flow: flowText === undefined ? FLOW_BUILDER_TEMPLATES[0].flow.flowId : undefined
        });
    });

    it('selects a template, resetting edited variables, and falls back to the first template for an unknown id', async () => {
        await render();
        await act(async () => {
            view.setVariablesEdited(true);
            view.setVariablesText('{"edited":true}');
        });
        await act(async () => view.selectTemplate(FLOW_BUILDER_TEMPLATES[1].templateId));
        const selectedTemplate = { templateId: view.templateId, flowId: view.flow?.flowId, variables: JSON.parse(view.variablesText) };
        await render({ globalValues: { ...globalValues, roomId: 'followed-room' } });
        const followed = JSON.parse(view.variablesText).groupId;
        await act(async () => view.selectTemplate('unknown-template'));

        expect({ selectedTemplate, followed, fallback: view.templateId }).toEqual({
            selectedTemplate: {
                templateId: FLOW_BUILDER_TEMPLATES[1].templateId,
                flowId: FLOW_BUILDER_TEMPLATES[1].flow.flowId,
                variables: globalVariables(globalValues, 1)
            },
            followed: 'followed-room',
            fallback: FLOW_BUILDER_TEMPLATES[0].templateId
        });
    });

    it('keeps edited variables when the global values change', async () => {
        await render();
        await act(async () => {
            view.setVariablesEdited(true);
            view.setVariablesText('{"edited":true}');
        });
        await render({ globalValues: { ...globalValues, roomId: 'ignored-room' } });

        expect(view.variablesText).toBe('{"edited":true}');
    });

    it('appends steps and normalizes flow JSON only while the flow parses', async () => {
        await render();
        const stepCount = view.flow?.steps.length ?? 0;
        await act(async () => view.addStep('rtc.send'));
        const appended = view.flow?.steps.at(-1)?.kind;
        const appendedCount = view.flow?.steps.length;
        await act(async () => view.setFlowText(JSON.stringify(view.flow)));
        await act(async () => view.normalizeFlowJson());
        const normalized = view.flowText === JSON.stringify(view.flow, null, 2);
        await act(async () => view.setFlowText('{'));
        await act(async () => view.addStep('wait'));
        const addError = view.localError;
        await act(async () => view.normalizeFlowJson());

        expect({
            stepCount: appendedCount,
            appended,
            normalized,
            addError: addError?.includes('JSON'),
            normalizeError: view.localError?.includes('JSON'),
            flowText: view.flowText
        }).toEqual({
            stepCount: stepCount + 1,
            appended: 'rtc.send',
            normalized: true,
            addError: true,
            normalizeError: true,
            flowText: '{'
        });
    });

    it('runs the flow recipe through the runtime, selecting a fresh command id per run and surfacing failures', async () => {
        await render();
        await act(async () => view.runFlow());
        runFailure.error = new Error('runtime rejected the recipe');
        await act(async () => view.runFlow());
        const failure = view.localError;
        await act(async () => view.setFlowText('{'));
        await act(async () => view.runFlow());

        expect({
            selected,
            runs: runs.map((run) => ({
                label: run.label,
                kinds: run.commands.map((command) => command.kind),
                commandIds: run.commands.map((command) => command.commandId),
                runLabels: run.commands.map((command) => command.label),
                recipeIds: run.commands.map((command) => command.kind === 'recipe.run' ? command.recipe?.recipeId : undefined)
            })),
            failure,
            parseFailure: view.localError?.includes('JSON')
        }).toEqual({
            selected: ['flow-builder-run-1', 'flow-builder-run-2'],
            runs: [1, 2].map((sequence) => ({
                label: 'Run Flow Builder',
                kinds: ['recipe.run'],
                commandIds: [`flow-builder-run-${sequence}`],
                runLabels: [`Run ${FLOW_BUILDER_TEMPLATES[0].flow.name}`],
                recipeIds: [FLOW_BUILDER_TEMPLATES[0].flow.flowId]
            })),
            failure: 'runtime rejected the recipe',
            parseFailure: true
        });
    });

    it('copies text to the clipboard', async () => {
        const copied: string[] = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        await render();
        await act(async () => view.copyText('flow text'));

        expect(copied).toEqual(['flow text']);
    });

    it.each(CLIPBOARD_FAILURES)('shows $name as a visible error when copying text', async ({ arrange, error }) => {
        await render();
        arrange();
        await act(async () => view.copyText('flow text'));

        expect(view.localError).toBe(error);
    });
});
