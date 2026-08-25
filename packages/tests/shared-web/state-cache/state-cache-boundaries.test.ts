import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSourceFile } from '../../helpers/source-analysis.ts';

const STATE_CACHE_ACCEPTANCE_OWNERS = [
    'browser-state-cache-lifecycle.ts',
    'group-state-delta-application.ts',
    'state-cache-snapshot-adoption.ts'
] as const;

describe('browser state-cache boundaries', () => {
    it('keeps remote state-read effects outside the cache acceptance owner', () => {
        const stateCacheDirectory = path.resolve(
            'packages/shared-web/browser/state-cache'
        );
        const remoteReadImports = STATE_CACHE_ACCEPTANCE_OWNERS
            .flatMap((fileName) =>
                analyzeSourceFile(path.join(stateCacheDirectory, fileName)).imports
                    .map((entry) => entry.specifier)
                    .filter((specifier) =>
                        specifier.startsWith('../state-read/') ||
                        specifier.startsWith('@shared-web/browser/state-read/')
                    )
                    .map((specifier) => `${fileName}: ${specifier}`)
            );

        expect(remoteReadImports).toEqual([]);
    });
});
