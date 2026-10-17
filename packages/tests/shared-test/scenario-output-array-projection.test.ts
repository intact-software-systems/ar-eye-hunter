import { describe, expect, it } from 'vitest';

import {
    resolveSafeOutputTransformPath,
    resolveSafeOutputTransformTemplate
} from '@shared-test/black-box-runner/scenario-transform/safe-output-transform-resolution.ts';

const INPUT = {
    resolverRoot: { sessions: [{ id: 'second' }, { id: 'first' }], empty: [], nested: [[{ id: 'a' }], [{ id: 'b' }, { id: 'c' }]], label: 'plain' },
    createUuid: () => 'unused',
    readTimestamp: () => 0
};

describe('safe output array path projection', () => {
    it('projects every array member in order and preserves nested arrays and empty arrays', () => {
        expect(resolveSafeOutputTransformPath('sessions.*.id', INPUT)).toEqual(['second', 'first']);
        expect(resolveSafeOutputTransformPath('empty.*.id', INPUT)).toEqual([]);
        expect(resolveSafeOutputTransformPath('nested.*.*.id', INPUT)).toEqual([['a'], ['b', 'c']]);
    });

    it.each([
        ['sessions.*.missing', INPUT],
        ['sessions.*.id', { ...INPUT, resolverRoot: { sessions: [{ id: 'present' }, {}] } }],
        ['label.*', INPUT],
        ['sessions.*.id', { ...INPUT, resolverRoot: { sessions: { '*': { id: 'object-key' } } } }]
    ])('refuses missing members and non-array projection: %s', (path, input) => {
        expect(() => resolveSafeOutputTransformPath(path, input)).toThrow();
    });

    it('preserves ordinary dot paths, bracket indices and template replacement', () => {
        expect(resolveSafeOutputTransformPath('sessions.0.id', INPUT)).toBe('second');
        expect(resolveSafeOutputTransformPath('sessions[1].id', INPUT)).toBe('first');
        expect(resolveSafeOutputTransformTemplate('value:{label}', INPUT)).toBe('value:plain');
        expect(resolveSafeOutputTransformTemplate('{sessions.1.id}', INPUT)).toBe('first');
    });
});
