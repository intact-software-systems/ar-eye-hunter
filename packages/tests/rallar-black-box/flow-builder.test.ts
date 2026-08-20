// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/types.ts';
import {
    FLOW_BUILDER_TEMPLATES,
    addFlowBuilderStep,
    applyFlowBuilderVariables,
    buildFlowBuilderRecipe,
    buildFlowBuilderRunnerScenario,
    parseFlowBuilderDefinition,
    templateFlowBuilderText,
} from '../../../apps/rallar-black-box/src/flow-builder.ts';
import { FlowBuilderPanel } from
    '../../../apps/rallar-black-box/src/legacy/runner/builder/FlowBuilderPanel.tsx';
import { flowBuilderVariablesFromGlobalValues } from
    '../../../apps/rallar-black-box/src/legacy/runner/builder/flow-builder-support.ts';
import type { CommandCenterGlobalValues } from
    '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const FLOW_BUILDER_STATE: RallarBlackBoxTestState = {
    status: 'idle',
    commandHistory: [],
    events: [],
    failures: [],
    resultCache: {},
};

const GLOBAL_VALUES: CommandCenterGlobalValues = {
    apiBaseUrl: 'https://api.example.test',
    applicationId: 'primary-application',
    workspaceId: 'primary-workspace',
    clientId: 'primary-client',
    sessionId: 'primary-session',
    roomId: 'primary-room',
};

describe('rallar-black-box flow builder helpers', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        container.remove();
        vi.restoreAllMocks();
    });

    it('substitutes string and structured variables without consuming auth placeholders', () => {
        const substituted = applyFlowBuilderVariables({
            path: '/api/state/apps/{{applicationId}}/workspaces/${workspaceId}/groups/{groupId}',
            payload: '{{payload}}',
            authUrl: '{auth.sessionId}',
        }, {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            payload: {
                text: 'hello',
            },
        });

        expect(substituted).toEqual({
            path: '/api/state/apps/app-1/workspaces/workspace-1/groups/group-1',
            payload: {
                text: 'hello',
            },
            authUrl: '{auth.sessionId}',
        });
    });

    it('builds a SPA recipe from the default flow template', () => {
        const flow = FLOW_BUILDER_TEMPLATES[0].flow;
        const recipe = buildFlowBuilderRecipe(flow, {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            payload: {
                text: 'hello flow',
            },
        });

        expect(recipe.recipeId).toBe('flow-auth-rest-ws-rtc');
        expect(recipe.commands.map(command => command.commandId)).toEqual([
            'flow-configure',
            'flow-auth-login',
            'flow-create-group',
            'flow-ws-open',
            'flow-ws-send',
            'flow-rtc-connect',
            'flow-rtc-send',
            'flow-wait',
            'flow-ws-close',
            'flow-close',
        ]);
        expect(recipe.commands[2]).toMatchObject({
            kind: 'http.request',
            request: {
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/app-1\/workspaces\/workspace-1\/groups\/requests\/[^/]+$/,
                ),
            },
        });
        expect(recipe.commands[2]).not.toMatchObject({
            request: {
                body: {
                    requestId: expect.anything(),
                },
            },
        });
        const replayRecipe = buildFlowBuilderRecipe(flow, {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
        });
        expect(replayRecipe.commands[2]).not.toMatchObject({
            request: {
                path: (recipe.commands[2] as { request?: { path?: string } }).request?.path,
            },
        });
        expect(recipe.commands[6]).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            send: {
                data: {
                    text: 'hello flow',
                },
                roomId: 'group-1',
            },
        });
    });

    it('exports a runner-style scenario with variables, connections, and steps', () => {
        const scenario = buildFlowBuilderRunnerScenario(FLOW_BUILDER_TEMPLATES[0].flow, {
            password: 'secret-password',
        });

        expect(scenario).toMatchObject({
            variables: {
                password: {
                    default: 'secret-password',
                    secret: true,
                },
            },
            connections: {
                api: {
                    type: 'http',
                },
                flowWs: {
                    type: 'ws',
                },
                flowRtc: {
                    type: 'rtc',
                },
            },
        });
        expect((scenario.steps as Array<{ type: string }>).map(step => step.type)).toContain('rtc.send');
        expect((scenario.steps as Array<{ type: string }>).map(step => step.type)).toContain('ws.open');
    });

    it('parses editable flow JSON and appends step templates', () => {
        const parsed = parseFlowBuilderDefinition(templateFlowBuilderText('auth-rest-ws-rtc'));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const next = addFlowBuilderStep(parsed.flow, 'rtc.send');
        expect(next.steps.at(-1)).toMatchObject({
            kind: 'rtc.send',
            label: 'Send RTC',
        });

        const withLogin = addFlowBuilderStep(parsed.flow, 'auth.login');
        const loginCommand = withLogin.steps.at(-1)?.commands?.[0];
        expect(loginCommand).toMatchObject({
            kind: 'http.request',
            request: {
                path: '/api/auth/login/requests/{{apiMutationRequestId}}',
            },
        });
    });

    it('keeps primary-owner drafts while mounted and resets them after unmount', async () => {
        await renderPanel(false);
        const editedFlow = JSON.stringify({
            ...FLOW_BUILDER_TEMPLATES[0].flow,
            name: 'Edited primary Flow Builder draft',
        }, null, 2);
        const editedVariables = JSON.stringify({
            applicationId: 'edited-application',
            draftMarker: 'visible-primary-owner',
        }, null, 2);

        await editTextarea('Flow JSON', editedFlow);
        await editTextarea('Variables JSON', editedVariables);

        await renderPanel(true, {
            ...GLOBAL_VALUES,
            applicationId: 'rerendered-application',
            roomId: 'rerendered-room',
        });

        expect(textarea('Flow JSON').value).toBe(editedFlow);
        expect(textarea('Variables JSON').value).toBe(editedVariables);
        expect(textarea('Flow JSON').disabled).toBe(true);
        expect(textarea('Variables JSON').disabled).toBe(true);

        await act(async () => root?.unmount());
        root = createRoot(container);
        await renderPanel(false);

        expect(textarea('Flow JSON').value).toBe(
            templateFlowBuilderText(FLOW_BUILDER_TEMPLATES[0].templateId),
        );
        expect(JSON.parse(textarea('Variables JSON').value)).toEqual(
            flowBuilderVariablesFromGlobalValues(
                FLOW_BUILDER_TEMPLATES[0].flow.variables,
                GLOBAL_VALUES,
            ),
        );
        expect(container.textContent).not.toContain(
            'Edited primary Flow Builder draft',
        );
        expect(container.textContent).not.toContain('visible-primary-owner');
    });

    async function renderPanel(
        busy: boolean,
        globalValues = GLOBAL_VALUES,
    ): Promise<void> {
        await act(async () => root?.render(createElement(FlowBuilderPanel, {
            state: FLOW_BUILDER_STATE,
            globalValues,
            busy,
            onSelectCommand: vi.fn(),
        })));
    }

    function textarea(label: string): HTMLTextAreaElement {
        const owner = [...container.querySelectorAll('label')]
            .find((candidate) => candidate.querySelector('span')?.textContent === label);
        const editor = owner?.querySelector('textarea');
        if (!(editor instanceof HTMLTextAreaElement)) {
            throw new Error(`Missing ${label} textarea`);
        }
        return editor;
    }

    async function editTextarea(label: string, value: string): Promise<void> {
        const editor = textarea(label);
        const setValue = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
        )?.set;
        if (!setValue) {
            throw new Error('Missing native textarea value setter');
        }
        await act(async () => {
            setValue.call(editor, value);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
});
