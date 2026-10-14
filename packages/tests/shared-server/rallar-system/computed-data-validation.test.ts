import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { validateComputedProjection } from '@shared-server/rallar-system/computed-data-validation.ts';

describe('computed data projection validation', () => {
    it('reports the exact path of every changed, missing and extra field', () => {
        const expected = { outer: { list: [{ value: 1 }, { value: 2 }], kept: 'same', removed: true } };
        const candidate = { outer: { list: [{ value: 1 }, { value: 3 }], kept: 'same', added: false } };

        expect(validateComputedProjection(expected, candidate, 'computed').map(({ message }) => message)).toEqual([
            'computed.outer.list.1.value differs from the computed value',
            'computed.outer.removed must be the computed data property',
            'computed.outer.added is not part of the computed value'
        ]);
    });

    it('reports an accessor at its own path before comparing any value', () => {
        const nested = { value: 1 };
        Object.defineProperty(nested, 'value', { enumerable: true, get: () => 2 });

        expect(validateComputedProjection({ outer: [{ value: 2 }] }, { outer: [nested] }, 'computed'))
            .toEqual([expect.objectContaining({
                path: 'computed.outer.0.value',
                message: 'computed.outer.0.value must be a data property'
            })]);
    });

    it('reports a cycle and an unsupported shape at their own paths', () => {
        const cyclic: { leaf: number; self?: object; } = { leaf: 1 };
        cyclic.self = cyclic;

        expect(validateComputedProjection({}, { nested: cyclic }, 'computed').map(({ message }) => message))
            .toEqual(['computed.nested.self must not contain a cycle']);
        expect(validateComputedProjection({}, { nested: new Map() }, 'computed').map(({ message }) => message))
            .toEqual(['computed.nested has an unsupported data shape']);
    });

    it('builds no path text while a wide candidate matches its computed value', () => {
        const expected = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field-${index}`, { index }]));
        const candidate = structuredClone(expected);
        const stringSink = vi.spyOn(globalThis, 'String');
        onTestFinished(() => stringSink.mockRestore());

        const issues = validateComputedProjection(expected, candidate, 'computed');

        expect(issues).toEqual([]);
        expect(stringSink).not.toHaveBeenCalled();
    });
});
