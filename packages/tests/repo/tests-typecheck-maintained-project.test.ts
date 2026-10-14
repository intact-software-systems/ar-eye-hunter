import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

const repositoryRoot = process.cwd();

describe('maintained test project typing on a clean checkout', () => {
    it('compiles and counts maintained tests without an untracked directory', () => {
        const root = createTypecheckProject();
        const passing = runTypecheck(root);

        expect(passing.status, passing.stderr + passing.stdout).toBe(0);
        expect(passing.stdout).toContain('2 filesystem test candidates inventoried');
        expect(passing.stdout).toContain('PASS: no new type errors in the maintained test project');
    });

    it('labels compiler-excluded maintained tests as filesystem candidates without claiming enforcement', () => {
        const root = createTypecheckProject();
        const excludedDirectory = path.join(root, 'packages/tests/shared-test/rtc-client-provider');
        mkdirSync(excludedDirectory, { recursive: true });
        writeFileSync(path.join(excludedDirectory, 'excluded.test.ts'), 'export const value: string = 1;\n');
        const passing = runTypecheck(root);

        expect(passing.status, passing.stderr + passing.stdout).toBe(0);
        expect(passing.stdout).toContain('3 filesystem test candidates inventoried');
        expect(passing.stdout).not.toContain('test files enforced');
        expect(passing.stdout).toContain('PASS: no new type errors in the maintained test project');
    });

    it('rejects an invalid compiler option', () => {
        const root = createTypecheckProject();
        writeFileSync(
            path.join(root, 'packages/tests/tsconfig.json'),
            JSON.stringify({
                compilerOptions: { invalidMaintainedTestOption: true, types: [] },
                include: ['**/*.ts']
            })
        );
        const failing = runTypecheck(root);

        expect(failing.status, failing.stderr + failing.stdout).toBe(1);
        expect(failing.stdout).toContain('new type errors in an enforced file: packages/tests/tsconfig.json (1)');
        expect(failing.stdout).not.toContain('PASS:');
    });

    it('rejects a missing project configuration instead of reporting an empty diagnostic inventory as clean', () => {
        const root = createTypecheckProject();
        rmSync(path.join(root, 'packages/tests/tsconfig.json'));
        const failing = runTypecheck(root);

        expect(failing.status, failing.stderr + failing.stdout).toBe(1);
        expect(failing.stdout).toContain('error TS5058:');
        expect(failing.stdout).not.toContain('PASS:');
    });

    it('keeps third-party declaration errors outside maintained test debt', () => {
        const root = createTypecheckProject();
        const dependencyDirectory = path.join(root, 'packages/tests/node_modules/dependency');
        mkdirSync(dependencyDirectory, { recursive: true });
        writeFileSync(path.join(dependencyDirectory, 'index.d.ts'), 'export type Value = MissingDependencyType;\n');
        writeFileSync(
            path.join(root, 'packages/tests/runtime.test.ts'),
            'import type { Value } from "./node_modules/dependency/index.d.ts"; export const value: Value = "package";\n'
        );
        const passing = runTypecheck(root);

        expect(passing.status, passing.stderr + passing.stdout).toBe(0);
        expect(passing.stdout).toContain('2 filesystem test candidates inventoried');
        expect(passing.stdout).toContain('PASS: no new type errors in the maintained test project');
    });

    it('rejects a real type error in a nested maintained test', () => {
        const root = createTypecheckProject();
        writeFileSync(path.join(root, 'packages/tests/nested/runtime.test.ts'), 'export const value: string = 1;\n');
        const failing = runTypecheck(root);

        expect(failing.status, failing.stderr + failing.stdout).toBe(1);
        expect(failing.stdout).toContain('2 filesystem test candidates inventoried');
        expect(failing.stdout).toContain('new type errors in an enforced file: packages/tests/nested/runtime.test.ts (1)');
    });
});

function createTypecheckProject(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-test-typecheck-'));
    onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    mkdirSync(path.join(root, 'packages/tests/nested'), { recursive: true });
    symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    for (const file of ['scripts/check-tests-typecheck.mjs', 'packages/tests/tsconfig.json']) {
        writeFileSync(path.join(root, file), readFileSync(path.join(repositoryRoot, file)));
    }
    writeFileSync(path.join(root, 'packages/tests/typecheck-debt.json'), JSON.stringify({ files: {} }));
    writeFileSync(path.join(root, 'packages/tests/runtime.test.ts'), 'export const value: string = "package";\n');
    writeFileSync(path.join(root, 'packages/tests/nested/runtime.test.ts'), 'export const value: string = "nested";\n');
    return root;
}

function runTypecheck(root: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ['scripts/check-tests-typecheck.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
}
