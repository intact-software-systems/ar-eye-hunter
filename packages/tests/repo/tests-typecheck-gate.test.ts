import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

interface TypeScriptConfig {
    compilerOptions?: { paths?: Record<string, string[]>; };
}

interface PackageManifest {
    scripts?: Record<string, string>;
}

interface TypecheckDebt {
    project: string;
    totalErrors: number;
    fileCount: number;
    files: Record<string, number>;
}

function readJson<T>(relativePath: string): T {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function readText(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function toAliasKeys(config: TypeScriptConfig): string[] {
    return Object.keys(config.compilerOptions?.paths ?? {}).toSorted();
}

describe('packages/tests typecheck gate', () => {
    it('declares every module alias the root project and the vitest runner declare', () => {
        const testsAliases = toAliasKeys(readJson<TypeScriptConfig>('packages/tests/tsconfig.json'));
        const rootAliases = toAliasKeys(readJson<TypeScriptConfig>('tsconfig.json'));

        // The three declaration sites in CLAUDE.md's runtime split must stay in step; the tests
        // project silently lost @shared-test/* and @relic-hunters/* once before.
        const vitestAliases = [
            ...readText('vitest.config.ts').matchAll(/^\s*'(@[\w-]+)':\s*path\.resolve/gmu)
        ]
            .map((match) => `${match[1]}/*`)
            .toSorted();

        expect(rootAliases.filter((alias) => !testsAliases.includes(alias))).toEqual([]);
        expect(vitestAliases.filter((alias) => !testsAliases.includes(alias))).toEqual([]);
        expect(vitestAliases.length).toBeGreaterThan(0);
    });

    it('runs the tests project from the root typecheck gate that CI executes', () => {
        const manifest = readJson<PackageManifest>('package.json');

        expect(manifest.scripts?.typecheck).toContain('npm run typecheck:tests');
        expect(manifest.scripts?.['typecheck:tests']).toBe('node scripts/check-tests-typecheck.mjs');
        expect(readText('.github/workflows/release-gate.yml')).toContain('npm run typecheck');
    });

    it('keeps the recorded debt well-formed so the allowlist can only shrink', () => {
        const debt = readJson<TypecheckDebt>('packages/tests/typecheck-debt.json');
        const entries = Object.entries(debt.files);
        const recordedTotal = entries.reduce((total, [, count]) => total + count, 0);

        expect(debt.project).toBe('packages/tests/tsconfig.json');
        expect(debt.fileCount).toBe(entries.length);
        expect(debt.totalErrors).toBe(recordedTotal);
        expect(entries.filter(([, count]) => !Number.isInteger(count) || count < 1)).toEqual([]);
        expect(entries.filter(([file]) => file.includes('node_modules'))).toEqual([]);
        expect(entries.filter(([file]) => file.startsWith('/') || file.includes('\\'))).toEqual([]);
    });
});
