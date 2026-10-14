import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    analyzeSource,
    analyzeSourceFile,
    type SourceAnalysis
} from '../../helpers/source-analysis.ts';

// Store scopes own data access; cleanup and retry scheduling belong to the runtime owner.
function findCleanupSchedulingImports(source: SourceAnalysis): readonly string[] {
    const cleanupModules = new Set([
        'open-indexed-db-admission-database',
        'open-indexed-db',
        'try-with-policy',
        'browser-al-runtime-cleanup'
    ]);
    return [
        ...source.imports.map((entry) => entry.specifier),
        ...source.dynamicImports.flatMap((entry) => entry.specifier ? [entry.specifier] : [])
    ].filter((specifier) => cleanupModules.has(path.basename(specifier).replace(/\.(?:ts|js)$/, '')));
}

describe('browser AL runtime ownership', () => {
    it('keeps store scopes independent from IndexedDB cleanup scheduling', () => {
        const stores = analyzeSourceFile(path.resolve(
            'packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts'
        ));
        expect(findCleanupSchedulingImports(stores)).toEqual([]);
    });

    it.each([
        '@shared/resilience/try-with-policy.ts',
        '@shared/alm/open-indexed-db-admission-database.ts',
        '@shared/persistence/open-indexed-db.ts',
        './browser-al-runtime-cleanup.ts'
    ])('detects the current scheduling boundary %s', (specifier) => {
        const source = analyzeSource(`import { owner } from '${specifier}';`, 'store-scope.ts');
        expect(findCleanupSchedulingImports(source)).toEqual([specifier]);
    });

    it('also detects a dynamically imported scheduling boundary', () => {
        const specifier = '@shared/resilience/try-with-policy.ts';
        const source = analyzeSource(`await import('${specifier}');`, 'store-scope.ts');
        expect(findCleanupSchedulingImports(source)).toEqual([specifier]);
    });
});
