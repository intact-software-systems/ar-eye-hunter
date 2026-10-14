import { describe, expect, it } from 'vitest';

import { createAlmScaleRecipes } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import { parseControlServerMessage } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import {
    computeDistributedAssertionFeatures,
    toControlAgentCapabilities,
    validateAgentAssertionCapability
} from '../../shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const group = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'alm-test' };
const identity = { runId: 'alm-test', agentId: 'agent-1' };

describe('set assertion control admission', () => {
    it.each([6, 11, 15, 30, 50] as const)('loads both canonical ALM recipes for %i participants', (participantCount) => {
        const { recipes } = createAlmScaleRecipes({ participantCount, group, readyTimeoutMs: 45_000 });
        expect(recipes).toHaveLength(2);

        for (const recipe of recipes) {
            const command = { kind: 'recipe.load', commandId: `load-${recipe.recipeId}`, recipe };
            expect(validateRallarBlackBoxTestCommand(command).ok).toBe(true);
            const parsed = parseControlServerMessage(
                JSON.stringify({
                    kind: 'command',
                    protocolVersion: 1,
                    ...identity,
                    commandId: command.commandId,
                    command
                }),
                identity
            );
            expect(parsed.ok).toBe(true);
        }
    });

    it('requires and advertises the set operator for the canonical sender recipe', () => {
        const { recipes } = createAlmScaleRecipes({ participantCount: 6, group, readyTimeoutMs: 45_000 });
        const features = computeDistributedAssertionFeatures(recipes);
        expect(features.operators).toContain('sameUniqueStringSet');

        const advertised = toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        });
        expect(advertised.assertions?.operators).toContain('sameUniqueStringSet');
        expect(validateAgentAssertionCapability(features, advertised)).toEqual([]);
        expect(validateAgentAssertionCapability(features, {
            ...advertised,
            assertions: {
                absence: true,
                untilLoop: true,
                operators: advertised.assertions?.operators.filter((operator) => operator !== 'sameUniqueStringSet') ?? []
            }
        })).toEqual(['assert operators: sameUniqueStringSet']);
    });

    it.each([
        { name: 'missing comparison source', command: { kind: 'assert', source: 'state.a', operator: 'sameUniqueStringSet' } },
        { name: 'blank comparison source', command: { kind: 'assert', source: 'state.a', operator: 'sameUniqueStringSet', comparisonSource: ' ' } },
        { name: 'non-string comparison source', command: { kind: 'assert', source: 'state.a', operator: 'sameUniqueStringSet', comparisonSource: 1 } },
        {
            name: 'unexpected expected value',
            command: { kind: 'assert', source: 'state.a', operator: 'sameUniqueStringSet', comparisonSource: 'state.b', expected: [] }
        },
        { name: 'missing source', command: { kind: 'assert', operator: 'sameUniqueStringSet', comparisonSource: 'state.b' } },
        { name: 'blank source', command: { kind: 'assert', source: ' ', operator: 'sameUniqueStringSet', comparisonSource: 'state.b' } },
        {
            name: 'comparison source on value operator',
            command: { kind: 'assert', source: 'state.a', operator: 'equals', comparisonSource: 'state.b', expected: 1 }
        }
    ])('rejects $name in control and schema admission', ({ command }) => {
        expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
        expect(
            parseControlServerMessage({
                kind: 'command',
                protocolVersion: 1,
                ...identity,
                commandId: 'invalid-assert',
                command
            }, identity).ok
        ).toBe(false);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
    });

    it('accepts the distinct set shape and an existing value operator in both validators', () => {
        for (
            const command of [
                { kind: 'assert', source: 'state.a', operator: 'sameUniqueStringSet', comparisonSource: 'state.b' },
                { kind: 'assert', source: 'state.a', operator: 'equals', expected: 1 }
            ]
        ) {
            expect(validateRallarBlackBoxTestCommand(command).ok).toBe(true);
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        }
    });
});
