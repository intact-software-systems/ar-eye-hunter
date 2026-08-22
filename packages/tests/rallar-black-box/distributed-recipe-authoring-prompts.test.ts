import { describe, expect, it } from 'vitest';
import {
    DISTRIBUTED_RECIPE_PROMPT_TEMPLATES,
    distributedRecipeSchemaContextText,
    distributedRecipeSchemaSnippets,
    redactDistributedRecipePromptVariables,
    renderDistributedRecipePromptTemplate,
    renderDistributedRecipeValidationFeedback
} from '../../../apps/rallar-black-box/src/distributed-recipe-authoring-prompts.ts';

describe('distributed recipe authoring prompts', () => {
    it('exposes the expected distributed recipe prompt templates', () => {
        expect(DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.map((template) => template.id)).toEqual([
            'live-group-ack',
            'ws-send-receive',
            'rtc-realtime-position',
            'looped-rtc-load',
            'parallel-ws-rtc-smoke',
            'wait-assert-evidence'
        ]);

        expect(DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.find((template) => template.id === 'parallel-ws-rtc-smoke')?.commandKinds).toEqual(
            expect.arrayContaining(['parallel', 'ws.send', 'rtc.send'])
        );
    });

    it('renders schema and capability context for browser-agent and distributed manifests', () => {
        const snippets = distributedRecipeSchemaSnippets();
        expect(snippets).toHaveLength(2);
        expect(snippets[0].text).toContain('Rallar black-box browser-agent recipe');
        expect(snippets[0].text).toContain('"commands"');
        expect(snippets[1].text).toContain('Rallar black-box distributed run manifest');
        expect(snippets[1].text).toContain('"targetPolicy"');

        const context = distributedRecipeSchemaContextText();
        expect(context).toContain('Relevant Command Capabilities');
        expect(context).toContain('ws.send: WebSocket Send');
        expect(context).toContain('rtc.send: RTC Send');
        expect(context).toContain('wait: Wait For Runtime Evidence');
    });

    it('redacts secret-like prompt variables without removing usable context', () => {
        const variables = redactDistributedRecipePromptVariables({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
            sessionId: 'session-secret',
            token: 'token-secret',
            headers: {
                Authorization: 'Bearer abc.def.ghi'
            },
            selectedAgentIds: ['agent-a', 'agent-b']
        });

        expect(variables.applicationId).toBe('rallar-server');
        expect(variables.groupId).toBe('bb-group');
        expect(variables.selectedAgentIds).toEqual(['agent-a', 'agent-b']);
        expect(variables.sessionId).toBe('[REDACTED]');
        expect(variables.token).toBe('[REDACTED]');
        expect(variables.headers).toEqual({ Authorization: '[REDACTED]' });
    });

    it('renders a copyable prompt with redacted global context and validation feedback', () => {
        const prompt = renderDistributedRecipePromptTemplate('rtc-realtime-position', {
            variables: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
                sessionId: 'session-secret',
                controlRunId: 'demo-run'
            },
            validationFeedback: {
                target: 'distributed-run-manifest',
                title: 'Distributed Manifest',
                ok: false,
                parseOk: true,
                schemaErrorText: '$.recipes[0].recipe: Missing required property commands',
                preflightWarnings: ['recipes[0] uses live RTC traffic']
            }
        });

        expect(prompt).toContain('Template: RTC Position Stream');
        expect(prompt).toContain('Return JSON only');
        expect(prompt).toContain('"sessionId": "[REDACTED]"');
        expect(prompt).toContain('RALLAR_BLACK_BOX');
        expect(prompt).toContain('$.recipes[0].recipe: Missing required property commands');
        expect(prompt).toContain('Preflight warning: recipes[0] uses live RTC traffic');
        expect(prompt).not.toContain('session-secret');
    });

    it('formats validation feedback for copy-back prompts', () => {
        const feedback = renderDistributedRecipeValidationFeedback({
            target: 'recipe',
            title: 'Recipe JSON',
            ok: false,
            parseOk: true,
            schemaErrorText: '$.commands: Missing required property commands',
            preflightErrors: ['recipes[0].commands[0] has no loop child commands.']
        });

        expect(feedback).toContain('Target: Recipe JSON');
        expect(feedback).toContain('Validation status: needs changes');
        expect(feedback).toContain('$.commands: Missing required property commands');
        expect(feedback).toContain('Preflight error: recipes[0].commands[0] has no loop child commands.');
    });
});
