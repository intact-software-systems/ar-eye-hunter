import {
    computeRelicPlanningAiSuggestion,
    decodeRelicPlanningAiContext,
    decodeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_PROMPT,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    RELIC_PLANNING_AI_SUGGESTION_SCHEMA,
    type RelicPlanningAiContext
} from '@relic-hunters/mod.ts';
import { validateRallarAiJsonSchemaValue } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import {
    createRelicPlanningAiActionOption,
    RELIC_PLANNING_AI_CONTEXT_FIXTURE
} from './relic-planning-ai-context-fixture.ts';

describe('the Relic planning companion contract', () => {
    it('names one schema and prompt both the browser and the server use', () => {
        expect(RELIC_PLANNING_AI_SCHEMA_ID).toBe('relic-hunters.planning-companion');
        expect(RELIC_PLANNING_AI_SCHEMA_VERSION).toBe('1');
        expect(RELIC_PLANNING_AI_PROMPT).toContain('Never submit actions');
    });

    it('accepts a legal suggestion and keeps only the fields the schema names', () => {
        const suggestion = {
            headline: 'Move toward Hallway',
            action: { kind: 'move', targetRoomId: 'hallway' },
            rationale: 'Hallway keeps a legal route open.',
            risks: ['Low health'],
            confidence: 'medium'
        };

        expect(decodeRelicPlanningAiSuggestion({ ...suggestion, vaultCode: '0451' }, CONTEXT).right)
            .toStrictEqual(suggestion);
    });

    it.each([
        { label: 'a move to a room that is not adjacent', patch: { action: { kind: 'move', targetRoomId: 'vault' } } },
        { label: 'a steal from a hunter out of reach', patch: { action: { kind: 'steal', targetPlayerId: 'carol-session' } } },
        { label: 'an action this turn forbids', patch: { action: { kind: 'escape' } } },
        { label: 'an unknown action kind', patch: { action: { kind: 'teleport' } } },
        { label: 'a headline beyond 80 characters', patch: { headline: 'x'.repeat(81) } },
        { label: 'a blank rationale', patch: { rationale: '  ' } },
        { label: 'four risks', patch: { risks: ['a', 'b', 'c', 'd'] } },
        { label: 'an unknown confidence', patch: { confidence: 'certain' } }
    ])('refuses $label', ({ patch }) => {
        const suggestion = {
            headline: 'Search the Entrance',
            action: { kind: 'search' },
            rationale: 'Nothing is known about this room yet.',
            risks: [],
            confidence: 'high',
            ...patch
        };

        expect(decodeRelicPlanningAiSuggestion(suggestion, CONTEXT).left).toEqual(expect.any(String));
    });

    it.each(FIXTURE_CONTEXTS)('decodes the $label context it receives as JSON', ({ context }) => {
        const decoded = decodeRelicPlanningAiContext(JSON.parse(JSON.stringify(context)));

        expect(decoded.right).toEqual(context);
    });

    it.each([
        { label: 'a non-object', value: 'context' },
        { label: 'another context schema', value: { ...CONTEXT, schema: 'relic-planning-ai-context-v2' } },
        { label: 'a missing action list', value: withoutField(CONTEXT, 'actionOptions') },
        { label: 'an unknown field', value: { ...CONTEXT, hiddenRelics: ['Golden Idol'] } },
        { label: 'an unsupported language', value: { ...CONTEXT, lang: 'de' } },
        { label: 'an unknown phase', value: { ...CONTEXT, phase: 'intermission' } },
        { label: 'a move target without a room id', value: { ...CONTEXT, moveTargets: [{ name: 'Hallway' }] } }
    ])('refuses $label as a context', ({ value }) => {
        expect(decodeRelicPlanningAiContext(value).left).toEqual(expect.any(String));
    });

    it.each(FIXTURE_CONTEXTS)('computes a legal, schema-valid suggestion for the $label context', ({ context, expected }) => {
        const suggestion = computeRelicPlanningAiSuggestion(context);

        expect(suggestion.action).toEqual(expected);
        expect(decodeRelicPlanningAiSuggestion(suggestion, context).right).toEqual(suggestion);
        expect(validateRallarAiJsonSchemaValue(RELIC_PLANNING_AI_SUGGESTION_SCHEMA, suggestion).ok).toBe(true);
    });
});

const CONTEXT = RELIC_PLANNING_AI_CONTEXT_FIXTURE;
const option = createRelicPlanningAiActionOption;

const FIXTURE_CONTEXTS: readonly Readonly<{
    label: string;
    context: RelicPlanningAiContext;
    expected: RelicPlanningAiContext['currentDraft'] | undefined;
}>[] = [
    { label: 'unexplored room', context: CONTEXT, expected: { kind: 'search' } },
    {
        label: 'scene-recommended move',
        context: { ...CONTEXT, sceneRecommendation: { kind: 'move', targetRoomId: 'hallway' } },
        expected: { kind: 'move', targetRoomId: 'hallway' }
    },
    {
        label: 'relic carrier at the Exit',
        context: {
            ...CONTEXT,
            localPlayer: { ...CONTEXT.localPlayer!, relicCount: 2 },
            actionOptions: [option('move', true), option('search', true), option('steal', false), option('escape', true)]
        },
        expected: { kind: 'escape' }
    },
    {
        label: 'investigated room',
        context: { ...CONTEXT, currentRoom: { ...CONTEXT.currentRoom!, investigated: true } },
        expected: { kind: 'move', targetRoomId: 'hallway' }
    },
    {
        label: 'cornered hunter',
        context: {
            ...CONTEXT,
            actionOptions: [option('move', false), option('search', false), option('steal', true), option('escape', false)],
            moveTargets: []
        },
        expected: { kind: 'steal', targetPlayerId: 'bob-session' }
    },
    {
        label: 'turn with no legal action',
        context: {
            ...CONTEXT,
            localPlayer: undefined,
            currentRoom: undefined,
            actionOptions: [option('move', false), option('search', false), option('steal', false), option('escape', false)],
            moveTargets: [],
            stealTargets: [],
            warnings: [{ kind: 'round-limit', severity: 'danger', message: 'The expedition ends this round.' }]
        },
        expected: undefined
    }
];

function withoutField(context: RelicPlanningAiContext, field: keyof RelicPlanningAiContext): object {
    return Object.fromEntries(Object.entries(context).filter(([key]) => key !== field));
}
