import { describe, expect, it } from 'vitest';
import { readScenarioRecipeIncludes, type ScenarioRecipe } from '../../../shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';

describe('recipe include expansion', () => {
    it('collects nested variables and connections before applying the enclosing recipe overrides', () => {
        const recipe: ScenarioRecipe = {
            interactions: {},
            variables: { shared: 'root' },
            defaults: { timeoutMs: 2000 },
            fragments: {
                actor: {
                    variables: { shared: 'fragment', actor: 'alice' },
                    connections: { rtc: { type: 'rtc', peerId: 'alice' } },
                    defaults: { type: 'rtc', timeoutMs: 500 },
                    steps: [{ name: 'send', connection: 'rtc', request: { send: '{actor}' } }]
                }
            },
            steps: [{ type: 'parallel', groups: [{ steps: [{ include: 'actor', namePrefix: 'alice-' }] }] }]
        };
        const before = JSON.stringify(recipe);
        const expanded = readScenarioRecipeIncludes(recipe, '/recipes/main.json', '/recipes');
        expect(expanded.config.variables).toEqual({ shared: 'root', actor: 'alice' });
        expect(expanded.config.connections).toEqual({ rtc: { type: 'rtc', peerId: 'alice' } });
        expect(expanded.config.defaults).toEqual({ type: 'rtc', timeoutMs: 2000 });
        expect(expanded.config.steps).toEqual([{
            type: 'parallel',
            groups: [{ steps: [{ name: 'alice-send', connection: 'rtc', request: { send: 'alice' } }] }]
        }]);
        expect(expanded.includes).toEqual([{ source: 'fragment:actor', path: 'actor', parent: 'main.json', stepIndex: 0, stepCount: 1 }]);
        expect(JSON.stringify(recipe)).toBe(before);
    });

    it('rejects recursive fragments and includes outside the recipe root', () => {
        const recipe: ScenarioRecipe = { interactions: {}, fragments: { self: [{ include: 'self' }] }, steps: [{ include: 'self' }] };
        expect(() => readScenarioRecipeIncludes(recipe, '/recipes/main.json', '/recipes')).toThrow('Circular include detected');
        expect(() => readScenarioRecipeIncludes({ ...recipe, steps: [{ include: '../secret.json' }] }, '/recipes/main.json', '/recipes')).toThrow(
            'Include path escapes recipe root'
        );
    });
});
