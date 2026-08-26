import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { constructionRuleIds } from '../../../scripts/repo-style-check/construction-rules.mjs';
import { navigationClassifications, navigationRuleIds } from '../../../scripts/repo-style-check/navigation-rules.mjs';
import { typeOrganizationRuleIds } from '../../../scripts/repo-style-check/type-organization-rules.mjs';

const repoRoot = process.cwd();
const canonicalStylePath = '.agents/skills/rallar-code-writing/references/repo-code-style.md';

describe('repo code style checker integrity', () => {
    it('documents the calibrated construction checker boundary', () => {
        const canonicalStyle = readRepo(canonicalStylePath);
        const humanGuide = readRepo('docs/repo-human-style-guide.md');
        const packageJson = readJson('package.json') as {
            scripts?: Readonly<Record<string, string>>;
        };
        const semanticBoundary = [
            'These findings identify syntax shapes for human review. They do not prove a',
            'construction graph is cyclic, a callback is unjustified, or a facade lacks a',
            'real boundary.'
        ].join(' ');

        expect(packageJson.scripts).toHaveProperty(
            'check:repo-style:construction-details',
            'node scripts/repo-style-check.mjs --construction-details'
        );
        expectAll(canonicalStyle, [
            '`construction.forward-capture`',
            'broader construction diagnostics remain opt-in'
        ]);
        expectAll(humanGuide, [
            '`construction.forward-capture`',
            'npm run check:repo-style:construction-details',
            '`construction.definite-assignment`',
            '`control.nested-callback-depth`',
            '`abstraction.pass-through`'
        ]);
        expect(humanGuide.replace(/\s+/g, ' ')).toContain(semanticBoundary);
    });

    it('keeps construction rule identifiers stable for checker integrations', () => {
        expect(Object.isFrozen(constructionRuleIds)).toBe(true);
        expect(constructionRuleIds).toEqual({
            forwardCapture: 'construction.forward-capture',
            definiteAssignment: 'construction.definite-assignment',
            nestedCallbackDepth: 'control.nested-callback-depth',
            passThrough: 'abstraction.pass-through'
        });
    });

    it('keeps IDE navigation reporting and changed-range enforcement wired into governance', () => {
        const packageJson = readJson('package.json') as {
            scripts?: Readonly<Record<string, string>>;
        };
        const governanceCommand = packageJson.scripts?.['test:repo-governance'] ?? '';
        const checker = readRepo('scripts/repo-style-check.mjs');
        const changedChecker = readRepo('scripts/check-changed-repo-style.mjs');
        const humanGuide = readRepo('docs/repo-human-style-guide.md');

        expect(navigationRuleIds).toEqual({
            registrationIndirection: 'navigation.registration-indirection',
            unnamedDeferredEdge: 'navigation.unnamed-deferred-edge',
            interfacePivot: 'navigation.interface-pivot'
        });
        expect(navigationClassifications).toEqual({
            highConfidenceFinding: 'high-confidence-finding',
            legitimateBoundary: 'legitimate-boundary',
            manualReview: 'unknown/manual-review'
        });
        expect(packageJson.scripts).toHaveProperty(
            'check:repo-style:navigation-details',
            'node scripts/repo-style-check.mjs --navigation-details'
        );
        expect(governanceCommand).toContain(
            'packages/tests/repo/repo-style-navigation-check.test.ts'
        );
        expectAll(checker, ['--navigation-details', 'formatNavigationReport']);
        expect(readRepo('scripts/repo-style-check/navigation-rules.mjs')).toContain(
            'import { extractRouteHandlerRanges } from \'./factory-route-rules.mjs\';'
        );
        expectAll(changedChecker, [
            'scanHighConfidenceNavigationFindings',
            'navigationClassifications.highConfidenceFinding'
        ]);
        expectAll(humanGuide, [
            'npm run check:repo-style:navigation-details',
            '`navigation.registration-indirection`',
            '`navigation.unnamed-deferred-edge`',
            '`navigation.interface-pivot`',
            'high-confidence finding',
            'legitimate dynamic boundary',
            'unknown/manual review',
            'new or worsened high-confidence',
            'Existing findings do not block'
        ]);
    });

    it('keeps type-organization rule identifiers stable and documented', () => {
        const humanGuide = readRepo('docs/repo-human-style-guide.md');
        const canonicalStyle = readRepo(canonicalStylePath);
        const typeOrganizationReference = readRepo(
            '.agents/skills/rallar-code-writing/references/typescript-type-organization.md'
        );

        expect(Object.isFrozen(typeOrganizationRuleIds)).toBe(true);
        expect(typeOrganizationRuleIds).toEqual({
            renameAlias: 'types.rename-alias',
            runtimeNamespace: 'types.runtime-namespace',
            enumDeclaration: 'types.enum-declaration'
        });
        for (const source of [humanGuide, canonicalStyle, typeOrganizationReference]) {
            expectAll(source, [
                'types.rename-alias',
                'types.runtime-namespace',
                'types.enum-declaration'
            ]);
        }
    });

    it('keeps TypeScript formatter settings aligned with the canonical baseline', () => {
        expect(existsSync(path.join(repoRoot, 'dprint.json'))).toBe(true);

        const dprint = readJson('dprint.json') as {
            lineWidth?: number;
            typescript?: Readonly<Record<string, unknown>>;
        };
        expect(dprint.lineWidth).toBe(100);
        expect(dprint.typescript).toMatchObject({
            lineWidth: 120,
            indentWidth: 4,
            useTabs: false,
            quoteStyle: 'alwaysSingle',
            semiColons: 'always',
            trailingCommas: 'never',
            'typeParameters.trailingCommas': 'onlyMultiLine'
        });
    });

    it('leaves dprint as the only formatter, including over Deno-owned TypeScript', () => {
        // `deno fmt` was retired in favour of a single formatter. A reintroduced `fmt` block or task
        // would silently reclaim these trees and fight dprint over the same TypeScript.
        for (
            const denoConfigPath of [
                'deno.json',
                'apps/api-v1/deno.json',
                'apps/rallar-black-box-control-server/deno.json',
                'apps/relic-hunter-server-v1/deno.json'
            ]
        ) {
            const deno = readJson(denoConfigPath) as {
                fmt?: unknown;
                tasks?: Readonly<Record<string, string>>;
            };
            expect(deno.fmt, denoConfigPath).toBeUndefined();
            expect(Object.keys(deno.tasks ?? {}), denoConfigPath).not.toContain('fmt');
        }

        const dprint = readJson('dprint.json') as { excludes?: readonly string[]; };
        for (
            const denoAppPath of [
                'apps/api-v1/**',
                'apps/rallar-black-box-control-server/**',
                'apps/relic-hunter-server-v1/**'
            ]
        ) {
            expect(dprint.excludes).not.toContain(denoAppPath);
        }

        expectAll(readRepo(canonicalStylePath), ['`dprint.json`']);
    });

    it('keeps every repo-style suite in the testing workflow', () => {
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const commands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');
        const packageJson = readJson('package.json') as {
            scripts?: Readonly<Record<string, string>>;
        };
        const governanceCommand = packageJson.scripts?.['test:repo-governance'] ?? '';

        expect(testing).toContain('npm run test:repo-governance');
        expect(commands).toContain('npm run test:repo-governance');

        for (
            const testPath of [
                'packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts',
                'packages/tests/repo/rallar-skill-app-examples-integrity.test.ts',
                'packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts',
                'packages/tests/repo/repo-code-style-authority-integrity.test.ts',
                'packages/tests/repo/repo-code-style-checker-integrity.test.ts',
                'packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts',
                'packages/tests/repo/repo-style-check.test.ts',
                'packages/tests/repo/repo-style-construction-check.test.ts',
                'packages/tests/repo/repo-style-construction-edge-cases.test.ts',
                'packages/tests/repo/repo-style-layout-rules.test.ts',
                'packages/tests/repo/repo-style-navigation-check.test.ts',
                'packages/tests/repo/repo-style-reviewed-dispositions.test.ts',
                'packages/tests/repo/repo-style-changed-check.test.ts',
                'packages/tests/rallar-black-box/rallar-testing-skill.test.ts'
            ]
        ) {
            expect(governanceCommand).toContain(testPath);
        }
    });
});

function readRepo(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function readJson(filePath: string): unknown {
    return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
    const normalized = haystack.replace(/\s+/g, ' ').trim();
    for (const needle of needles) {
        expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim());
    }
}
