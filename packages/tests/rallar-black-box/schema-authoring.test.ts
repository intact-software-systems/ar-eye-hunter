import { describe, expect, it } from 'vitest';
import {
    commandExampleSnippets,
    schemaAuthoringSummary,
    schemaAuthoringTone,
    validateSchemaAuthoringText,
    validateSchemaAuthoringValue,
} from '../../../apps/rallar-black-box/src/schema-authoring.ts';

describe('schema authoring helpers', () => {
    it('validates command JSON and exposes capability hints', () => {
        const validation = validateSchemaAuthoringText('command', JSON.stringify({
            kind: 'http.request',
            request: {
                method: 'GET',
                path: '/api/config',
            },
        }));

        expect(validation.ok).toBe(true);
        expect(validation.commandKinds).toEqual(['http.request']);
        expect(validation.providerModes).toContain('rallar-server');
        expect(validation.liveServiceRequirements).toContain('HTTP endpoint');
        expect(validation.artifactExpectations).toContain('HTTP status');
        expect(validation.distributedCompatible).toBe(true);
        expect(schemaAuthoringTone(validation)).toBe('warn');
        expect(schemaAuthoringSummary(validation)).toContain('live requirements');
    });

    it('returns parse and schema errors for invalid JSON', () => {
        const parseValidation = validateSchemaAuthoringText('recipe', '{');
        expect(parseValidation.ok).toBe(false);
        expect(parseValidation.parseOk).toBe(false);
        expect(parseValidation.errorText).toContain('$:');

        const schemaValidation = validateSchemaAuthoringValue('command', {
            kind: 'http.request',
        });
        expect(schemaValidation.ok).toBe(false);
        expect(schemaValidation.parseOk).toBe(true);
        expect(schemaValidation.errorText).toContain('Missing required property request');
    });

    it('validates recipe and distributed manifests and derives command kinds from inline recipes', () => {
        const recipe = {
            recipeId: 'authoring-recipe',
            commands: [
                { kind: 'health' },
                { kind: 'rtc.connect', connection: 'aliceRtc' },
            ],
        };
        const recipeValidation = validateSchemaAuthoringValue('recipe', recipe);
        expect(recipeValidation.ok).toBe(true);
        expect(recipeValidation.commandKinds).toEqual(['health', 'rtc.connect']);

        const manifestValidation = validateSchemaAuthoringValue('distributed-run-manifest', {
            schemaVersion: 1,
            distributedRunId: 'dist-authoring',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            recipes: [{ recipeId: recipe.recipeId, recipe }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-a'],
            },
        });

        expect(manifestValidation.ok).toBe(true);
        expect(manifestValidation.commandKinds).toEqual(['health', 'rtc.connect']);
        expect(manifestValidation.runtimeSurfaces).toContain('control-agent');
    });

    it('generates one example snippet for each command capability', () => {
        const snippets = commandExampleSnippets();
        expect(snippets.length).toBeGreaterThan(10);
        expect(snippets.map(snippet => snippet.kind)).toContain('ws.send');
        expect(snippets.find(snippet => snippet.kind === 'ws.send')?.commandText).toContain('"kind": "ws.send"');
    });
});
