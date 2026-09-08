import {
    describe,
    expect,
    it
} from 'vitest';
import { readScenarioRecipeIncludes, type ScenarioRecipe } from '../../../shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';
import { readScenarioWorkload, type ScenarioWorkload } from '../../../shared-test/black-box-runner/recipes/scenario-workload.ts';
import { toExecutableInteractions } from '../../../shared-test/black-box-runner/recipes/to-executable-interactions.ts';

function compileVariable(value: string): unknown {
    const compiled = toExecutableInteractions({
        interactions: {},
        variables: { token: value },
        steps: [{ name: 'capture', type: 'set', output: 'captured', value: '{token}' }]
    });
    return compiled[0].SET?.request.value;
}

function trafficRecipe(weight: number | string, count: number | string): ScenarioRecipe {
    return {
        interactions: {},
        steps: [],
        execution: {
            trafficPlan: {
                seed: 20260601,
                count,
                operations: ['alpha', 'beta'].map((name) => ({
                    name,
                    weight,
                    steps: [{
                        name,
                        type: 'set',
                        output: 'result{traffic.sequence}',
                        value: {
                            sequence: '{traffic.sequence}',
                            label: 'seq-{traffic.sequence}'
                        }
                    }]
                }))
            }
        }
    };
}

function expandTraffic(recipe: ScenarioRecipe): ScenarioWorkload {
    return readScenarioWorkload(recipe, {
        delayMs: 0,
        requestedIterations: undefined,
        maxDurationMs: 0,
        maxRuns: 1,
        stopOnFailure: true
    });
}

describe('recipe compiler boundaries', () => {
    it.each(['simple-token', '123', 'a"b', String.raw`C:\temp`, 'a\nb'])('preserves valid string variable %j', (value) => {
        expect(compileVariable(value)).toBe(value);
    });

    it('retains unresolved runtime placeholders and inline numeric-string replacement', () => {
        const result = toExecutableInteractions({
            interactions: {},
            variables: { prefix: '123' },
            steps: [{ name: 'capture', type: 'set', value: '{prefix}:{outputs.later}' }]
        });
        expect(result[0].SET?.request.value).toBe('123:{outputs.later}');
    });

    it('preserves weighted seeded selection when finite equal weights would overflow their sum', () => {
        const ordinary = expandTraffic(trafficRecipe(1, 20)).artifact!;
        const large = expandTraffic(trafficRecipe(1e308, 20)).artifact!;
        expect(new Set(ordinary.decisions.map((decision) => decision.operation)).size).toBe(2);
        expect(large.decisions.map((decision) => decision.operation)).toEqual(ordinary.decisions.map((decision) => decision.operation));
    });

    it('preserves numeric-string count and weights, exact generated template types and replay steps', () => {
        const ordinary = expandTraffic(trafficRecipe(1, 20)).artifact!;
        const strings = expandTraffic(trafficRecipe('1', '20')).artifact!;
        expect(strings.decisions).toEqual(ordinary.decisions);
        expect(strings.steps[0].value).toEqual({ sequence: 1, label: 'seq-1' });
        const replay = expandTraffic(strings.replayRecipe).artifact!;
        expect(replay.replay).toBe(true);
        expect(replay.steps).toEqual(strings.steps);
    });

    it('rejects non-finite traffic weights at normalization', () => {
        expect(() => expandTraffic(trafficRecipe(Infinity, 1))).toThrow('Traffic operation weight must be finite.');
    });

    it('preserves exact include object substitution and generated receipt metadata', () => {
        const expanded = readScenarioRecipeIncludes(
            {
                interactions: {},
                fragments: { capture: { steps: [{ type: 'set', value: '{payload}' }] } },
                steps: [{ include: { fragment: 'capture', variables: { payload: { nested: ['a"b', 3] } } } }]
            },
            '/recipes/main.json',
            '/recipes'
        );
        expect(expanded.config.steps?.[0].value).toEqual({ nested: ['a"b', 3] });
        expect(expanded.includes).toEqual([{ source: 'fragment:capture', path: 'capture', parent: 'main.json', stepIndex: 0, stepCount: 1 }]);
    });
});

for (const field of ['comparison', 'ignoreJsonKeys', 'ignoreJsonPaths'] as const) {
    it.each([false, 0, null, ''])(`preserves explicitly supplied ${field} control %j for validation`, (value) => {
        const compiled = toExecutableInteractions({
            defaults: { [field]: field === 'comparison' ? 'EXACT' : ['valid'] },
            steps: [{ type: 'assert', actual: 1, expect: { body: 1, [field]: value } }]
        });
        expect(compiled[0].ASSERT?.response[field]).toBe(value);
    });
    it(`applies the ${field} default only when omitted`, () => {
        const value = field === 'comparison' ? 'EXACT' : ['valid'];
        const compiled = toExecutableInteractions({
            defaults: { [field]: value },
            steps: [{ type: 'assert', actual: 1, expect: { body: 1 } }]
        });
        expect(compiled[0].ASSERT?.response[field]).toEqual(value);
    });
}
