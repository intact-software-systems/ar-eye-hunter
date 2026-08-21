import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

describe('rallar-testing skill guidance', () => {
    it('requires human-operated Playwright coverage for changed UI behavior', () => {
        const skill = readFileSync(
            resolve(REPO_ROOT, '.agents/skills/rallar-testing/SKILL.md'),
            'utf8'
        );
        const commands = readFileSync(
            resolve(REPO_ROOT, '.agents/skills/rallar-testing/references/test-commands.md'),
            'utf8'
        );
        const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
            scripts?: Readonly<Record<string, string>>;
        };
        const governanceCommand = packageJson.scripts?.['test:repo-governance'] ?? '';

        expect(skill).toContain('UI Behavior Rule');
        expect(skill).toContain('operates visible controls a human would use');
        expect(skill).toContain('cannot be the only proof for a human-facing workflow');
        expect(commands).toContain('UI Workflow Testing');
        expect(commands).toContain('Prefer role/label selectors');
        expect(commands).toContain(
            'npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts'
        );
        expect(commands).toContain('npm run test:repo-governance');
        for (
            const testPath of [
                'packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts',
                'packages/tests/repo/rallar-skill-app-examples-integrity.test.ts',
                'packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts',
                'packages/tests/repo/repo-code-style-authority-integrity.test.ts',
                'packages/tests/repo/repo-code-style-checker-integrity.test.ts',
                'packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts',
                'packages/tests/repo/repo-style-changed-check.test.ts'
            ]
        ) {
            expect(governanceCommand).toContain(testPath);
        }
        expect(governanceCommand).toContain(
            'packages/tests/rallar-black-box/rallar-testing-skill.test.ts'
        );
        expect(existsSync(resolve(REPO_ROOT, 'playwright.config.ts'))).toBe(false);
    });

    it('requires behavior-named route-owner suites and semantic mutation assertions', () => {
        const skill = readFileSync(
            resolve(REPO_ROOT, '.agents/skills/rallar-testing/SKILL.md'),
            'utf8'
        );
        const commands = readFileSync(
            resolve(REPO_ROOT, '.agents/skills/rallar-testing/references/test-commands.md'),
            'utf8'
        );

        expect(skill).toContain('behavior-named test modules');
        for (
            const field of [
                'entry',
                'transaction',
                'commit return',
                'after-commit',
                'failure',
                'cleanup',
                'final result'
            ]
        ) {
            expect(skill).toContain(field);
        }
        for (
            const suite of [
                'mutation-route-owner-analysis.test.ts',
                'mutation-route-owner-boundary-traversal.test.ts',
                'mutation-route-owner-provenance.test.ts',
                'mutation-route-owner-registration-collections.test.ts',
                'mutation-route-owner-registration-predicates.test.ts',
                'mutation-route-owner-logical-predicates.test.ts',
                'mutation-route-owner-call-effects.test.ts',
                'mutation-route-owner-object-projections.test.ts',
                'mutation-route-owner-map-projections.test.ts',
                'mutation-route-owner-lexical-resolution.test.ts',
                'mutation-route-owner-call-aliases.test.ts',
                'mutation-route-owner-control-flow-alternatives.test.ts',
                'mutation-route-owner-loop-and-switch-flow.test.ts',
                'mutation-route-owner-execution-state.test.ts',
                'mutation-route-owner-abrupt-completion.test.ts',
                'mutation-route-owner-loop-completion.test.ts',
                'mutation-route-owner-loop-divergence.test.ts',
                'mutation-route-owner-loop-fixed-point.test.ts',
                'mutation-route-owner-state-coalescing.test.ts',
                'app-group-inbox-registration-lifecycle.test.ts',
                'group-state-inbox-transaction-result.test.ts',
                'authoritative-mutation-read-compute-validate-write.test.ts'
            ]
        ) {
            expect(commands).toContain(suite);
        }
    });

    it('treats semantic behavior as primary over temporary mechanical ratchets', () => {
        const skill = readFileSync(
            resolve(REPO_ROOT, '.agents/skills/rallar-testing/SKILL.md'),
            'utf8'
        );
        const normalizedSkill = skill.replace(/\s+/g, ' ').trim();

        expect(normalizedSkill).toContain('Semantic tests are primary');
        expect(normalizedSkill).toContain(
            'Source inventories, exact-tree checks, string assertions, and line/count ratchets'
        );
        expect(normalizedSkill).toContain('supplementary and temporary');
        expect(normalizedSkill).toContain('named owner and removal condition');
    });
});
