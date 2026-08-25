import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis.ts';

describe('browser AL runtime ownership', () => {
    it('keeps store scopes independent from IndexedDB cleanup scheduling', () => {
        const stores = analyzeSourceFile(path.resolve(
            'packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts'
        ));
        const cleanupImports = stores.imports
            .map((entry) => entry.specifier)
            .filter((specifier) =>
                specifier.includes('openIndexedDb') ||
                specifier.includes('TryWith')
            );

        expect(cleanupImports).toEqual([]);
    });
});
