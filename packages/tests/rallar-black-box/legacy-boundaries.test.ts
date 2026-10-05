import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { buildRelativeTypeScriptGraph, findDependencyCycles } from '../helpers/source-analysis';

const legacyExperienceSourcePath = path.resolve(
    import.meta.dirname,
    '../../../apps/rallar-black-box/src/legacy/shell/legacy-experience.tsx'
);

describe('Rallar Black Box legacy dependency boundary', () => {
    it('keeps the reachable legacy TypeScript dependency graph acyclic', () => {
        const graph = buildRelativeTypeScriptGraph([legacyExperienceSourcePath]);
        expect(findDependencyCycles(graph)).toEqual([]);
    });
});
