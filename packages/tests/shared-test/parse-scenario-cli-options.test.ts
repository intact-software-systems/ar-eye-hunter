import { describe, expect, it } from 'vitest';
import { parseScenarioCliOptions } from '../../shared-test/black-box-runner/parse-scenario-cli-options.ts';

describe('scenario CLI options', () => {
    it('normalizes aliases and preserves literal replacement text without changing argv', () => {
        const args = Object.freeze(['-c', 'first.json', '--config=recipe.json', '-r', 'url:=https://host/a?x=1', '--runs=3', '--strict', '--profile=compat']);
        expect(parseScenarioCliOptions(args).right).toEqual({
            kind: 'run',
            options: { config: 'recipe.json', replace: 'url:=https://host/a?x=1', iterations: '3', strict: true, profile: 'compat' }
        });
        expect(args[1]).toBe('first.json');
    });

    it('returns help as data without requiring a config', () => {
        expect(parseScenarioCliOptions(['--help']).right).toEqual({ kind: 'help' });
    });

    it.each([[], ['--config='], ['-c', '--explain']].map((args) => ({ args })))('returns a failure for missing configuration: $args', ({ args }) => {
        expect(parseScenarioCliOptions(args).left).toBeInstanceOf(Error);
    });
});
