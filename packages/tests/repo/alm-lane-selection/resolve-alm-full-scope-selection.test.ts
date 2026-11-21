import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveAlmFullScopeSelection } from '../../../../scripts/alm-lane-selection/resolve-alm-full-scope-selection.mjs';

describe('ALM full-scope selection', () => {
    it('does not run the full scope when nothing changed', () => {
        expect(resolveAlmFullScopeSelection([])).toEqual({ runFullScope: false, decidingPaths: [] });
    });

    it('does not run the full scope when every path cannot change the lane', () => {
        expect(resolveAlmFullScopeSelection([
            'docs/a.md',
            'apps/relic-hunters-v1/src/x.ts',
            'packages/tests/shared/alm/y.test.ts'
        ])).toEqual({ runFullScope: false, decidingPaths: [] });
    });

    it('runs the full scope for a shared-package path and names it', () => {
        expect(resolveAlmFullScopeSelection([
            'docs/a.md',
            'apps/relic-hunters-v1/src/x.ts',
            'packages/tests/shared/alm/y.test.ts',
            'packages/shared/alm/outbound/z.ts'
        ])).toEqual({ runFullScope: true, decidingPaths: ['packages/shared/alm/outbound/z.ts'] });
    });

    it('runs the full scope for a repository test that pins the workflows', () => {
        expect(resolveAlmFullScopeSelection(['packages/tests/repo/alm-observation-workflow.test.ts']).runFullScope)
            .toBe(true);
    });

    it('runs the full scope for a path it does not know', () => {
        expect(resolveAlmFullScopeSelection(['some/new/top-level/file.ts']).runFullScope).toBe(true);
    });

    it('runs the full scope for a gate workflow but not for a hosted-fleet workflow', () => {
        expect(resolveAlmFullScopeSelection(['.github/workflows/release-gate.yml']).runFullScope).toBe(true);
        expect(
            resolveAlmFullScopeSelection(['.github/workflows/hetzner-supported-distributed-manifests.yml']).runFullScope
        ).toBe(false);
    });

    it('names at most five deciding paths', () => {
        const unknownPaths = Array.from({ length: 7 }, (_, index) => `unknown/path-${String(index)}.ts`);

        expect(resolveAlmFullScopeSelection(unknownPaths).decidingPaths).toEqual(unknownPaths.slice(0, 5));
    });
});
