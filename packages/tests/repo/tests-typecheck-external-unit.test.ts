import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

const repositoryRoot = process.cwd();

describe('maintained external unit test typing', () => {
    it('counts both test roots and rejects a real type error in the external unit root', () => {
        const root = createTypecheckProject();
        const passing = runTypecheck(root);
        expect(passing.status, passing.stderr + passing.stdout).toBe(0);
        expect(passing.stdout).toContain('2 test files enforced');

        writeFileSync(path.join(root, 'tests/unit/runtime.test.ts'), 'export const value: string = 1;\n');
        const failing = runTypecheck(root);
        expect(failing.status, failing.stderr + failing.stdout).toBe(1);
        expect(failing.stdout).toContain('2 test files enforced');
        expect(failing.stdout).toContain('new type errors in an enforced file: tests/unit/runtime.test.ts (1)');
    });
});

function createTypecheckProject(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-test-typecheck-'));
    onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
    });
    for (const directory of ['scripts', 'packages/tests', 'tests/unit', 'node_modules']) {
        mkdirSync(path.join(root, directory), { recursive: true });
    }
    const compilerPackage = createRequire(import.meta.url).resolve('typescript/package.json');
    symlinkSync(path.dirname(compilerPackage), path.join(root, 'node_modules/typescript'), 'junction');
    writeFileSync(
        path.join(root, 'scripts/check-tests-typecheck.mjs'),
        readFileSync(path.join(repositoryRoot, 'scripts/check-tests-typecheck.mjs'))
    );
    writeFileSync(path.join(root, 'packages/tests/typecheck-debt.json'), JSON.stringify({ files: {} }));
    writeFileSync(
        path.join(root, 'packages/tests/tsconfig.json'),
        JSON.stringify({
            compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext', types: [] },
            include: readTestProjectIncludes()
        })
    );
    writeFileSync(path.join(root, 'packages/tests/runtime.test.ts'), 'export const value: string = "package";\n');
    writeFileSync(path.join(root, 'tests/unit/runtime.test.ts'), 'export const value: string = "external";\n');
    return root;
}

function readTestProjectIncludes(): readonly string[] {
    const config: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/tests/tsconfig.json'), 'utf8'));
    if (
        !config || typeof config !== 'object' || !('include' in config) ||
        !Array.isArray(config.include) || !config.include.every((entry): entry is string => typeof entry === 'string')
    ) {
        throw new Error('The maintained test project must declare its included source paths.');
    }
    return config.include;
}

function runTypecheck(root: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ['scripts/check-tests-typecheck.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
}
