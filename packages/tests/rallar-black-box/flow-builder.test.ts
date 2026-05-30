import { describe, expect, it } from 'vitest';
import {
    FLOW_BUILDER_TEMPLATES,
    addFlowBuilderStep,
    applyFlowBuilderVariables,
    buildFlowBuilderRecipe,
    buildFlowBuilderRunnerScenario,
    parseFlowBuilderDefinition,
    templateFlowBuilderText,
} from '../../../apps/rallar-black-box/src/flow-builder.ts';

describe('rallar-black-box flow builder helpers', () => {
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
                path: '/api/state/apps/app-1/workspaces/workspace-1/groups',
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
    });
});
