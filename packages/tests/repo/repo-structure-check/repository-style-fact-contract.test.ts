import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectRepositoryStyleFacts } from '../../../../scripts/repo-style-check/structural-facts.mjs';

const repoRoot = path.resolve('/repo');

describe('repository style structural fact contract', () => {
    it('exports density, prefix-cluster, and navigation-size facts from the canonical owner', () => {
        const sources = Array.from({ length: 21 }, (_, index) => ({
            file: path.join(repoRoot, 'apps/example', `read-feature-${index}.ts`),
            raw: index === 0
                ? Array.from({ length: 1201 }, (_, line) => `const value${line} = true;`).join('\n')
                : ''
        }));

        const facts = collectRepositoryStyleFacts({ repoRoot, sources });

        expect(facts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ruleId: 'layout.directory-density',
                    target: 'apps/example',
                    magnitude: 21
                }),
                expect.objectContaining({
                    ruleId: 'layout.feature-prefix-cluster',
                    target: 'apps/example',
                    identity: 'feature',
                    magnitude: 21
                }),
                expect.objectContaining({
                    ruleId: 'file.length',
                    target: 'apps/example/read-feature-0.ts',
                    magnitude: 1201
                })
            ])
        );
    });
});
