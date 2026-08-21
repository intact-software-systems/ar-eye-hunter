import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    isNonProductionPath,
    isProductionCodeFile,
    isTestEnforcedFinding,
    isTestSourceFile,
    resolveFileLineBackstop,
    testEnforcedRuleIds
} from '../../../scripts/repo-style-check/repository-scan.mjs';

const repoRoot = process.cwd();

function readStyleAuthority(): string {
    return readFileSync(path.join(repoRoot, '.agents/skills/rallar-code-writing/references/repo-code-style.md'), 'utf8');
}

function readScanner(): string {
    return readFileSync(path.join(repoRoot, 'scripts/repo-style-check/repository-scan.mjs'), 'utf8');
}

describe('repo style test calibration', () => {
    it('gives test files the wider navigation backstop the test corpus was measured against', () => {
        expect(resolveFileLineBackstop('packages/tests/shared/queue.test.ts')).toBe(1500);
        expect(resolveFileLineBackstop('apps/api-v1/test/db/pglite-sql-adapter.test.ts')).toBe(1500);
        expect(resolveFileLineBackstop('packages/shared/queuebox/ResourceEntry.ts')).toBe(1200);
        expect(resolveFileLineBackstop('apps/api-v1/src/main.ts')).toBe(1200);
    });

    it('scans test sources without counting them as production', () => {
        expect(isProductionCodeFile('packages/tests/shared/queue.test.ts')).toBe(false);
        expect(isTestSourceFile('packages/tests/shared/queue.test.ts')).toBe(true);
        expect(isTestSourceFile('packages/tests/create-test-group.ts')).toBe(true);
        expect(isTestSourceFile('apps/api-v1/test/db/pglite-sql-adapter.test.ts')).toBe(true);
        expect(isTestSourceFile('packages/shared/queuebox/ResourceEntry.ts')).toBe(false);
    });

    it('blocks only the staged rules when the changed file is a test', () => {
        const testFile = 'packages/tests/shared/queue.test.ts';

        expect([...testEnforcedRuleIds].toSorted()).toEqual([
            'boundary.unknown',
            'construction.forward-capture'
        ]);
        expect(isTestEnforcedFinding(testFile, 'boundary.unknown')).toBe(true);
        expect(isTestEnforcedFinding(testFile, 'file.cognitive-load')).toBe(false);
        expect(isTestEnforcedFinding(testFile, 'file.length')).toBe(false);
    });

    // Layout findings are reported against a directory, which has no extension. Keying the staging on
    // the file kind would let those through as if the directory were production.
    it('stages a directory-level finding under the test tree the same way', () => {
        expect(isTestEnforcedFinding('packages/tests/repo', 'layout.directory-density')).toBe(false);
        expect(isTestEnforcedFinding('packages/shared', 'layout.directory-density')).toBe(true);
    });

    it('leaves every rule blocking on production paths', () => {
        for (const ruleId of ['file.cognitive-load', 'file.length', 'boundary.unknown']) {
            expect(isTestEnforcedFinding('packages/shared/queuebox/ResourceEntry.ts', ruleId)).toBe(true);
        }
    });

    it('states both backstops in the authority the checker implements', () => {
        const authority = readStyleAuthority();

        expect(authority).toContain('`1,200` physical lines');
        expect(authority).toContain('`1,500`-line backstop');
    });

    // The calibration is deliberately narrow: only physical length differs. Cognitive load and
    // responsibility count are stricter on the test corpus than on production, so relaxing them
    // would loosen a rule tests already satisfy.
    it('relaxes no file metric for tests other than physical length', () => {
        const scanner = readScanner();

        expect(scanner).not.toContain('testCognitiveLoad');
        expect(scanner).not.toContain('testResponsibilityCount');
        expect(scanner).not.toContain('testHandlerComplexity');
    });

    it('resolves conventional role qualifiers before reading a filename stem', () => {
        const layoutRules = readFileSync(path.join(repoRoot, 'scripts/repo-style-check/layout-rules.mjs'), 'utf8');

        expect(layoutRules).toContain('fileRoleQualifierPattern');
        expect(layoutRules).toContain('.replace(fileRoleQualifierPattern');
    });

    it('classifies the test tree as non-production so the wider backstop applies to it', () => {
        expect(isNonProductionPath('packages/tests/shared/queue.test.ts')).toBe(true);
        expect(isNonProductionPath('apps/api-v1/test/db/pglite-sql-adapter.test.ts')).toBe(true);
        expect(isNonProductionPath('packages/shared/queuebox/ResourceEntry.ts')).toBe(false);
        expect(isNonProductionPath('apps/api-v1/src/main.ts')).toBe(false);
    });
});
