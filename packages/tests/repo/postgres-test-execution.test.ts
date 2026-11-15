import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

const repositoryRoot = process.cwd();
const checkerPath = path.join(repositoryRoot, 'scripts/check-postgres-test-selection.mjs');
const reporterPath = path.join(repositoryRoot, 'scripts/postgres-test-execution-reporter.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('PostgreSQL test selection', { timeout: 35_000 }, () => {
    it('accepts files selected by separate PostgreSQL lanes', () => {
        const root = createFixture({
            'packages/tests/primary.test.ts': conditionalCases('primary'),
            'packages/tests/separate.test.ts': conditionalCases('separate')
        });
        writeSelectionConfig(root, ['packages/tests/primary.test.ts']);
        writeFile(root, 'separate.config.mjs', 'export default { test: { include: ["packages/tests/separate.test.ts"] } };');
        writeFile(
            root,
            'package.json',
            JSON.stringify({
                scripts: {
                    'test:postgres:integration': 'RALLAR_POSTGRES_INTEGRATION=1 vitest run --config primary.config.mjs',
                    'test:postgres:presence-expiry': 'RALLAR_POSTGRES_INTEGRATION=1 vitest run --config separate.config.mjs'
                }
            })
        );

        const result = runSelection(root);

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('2 candidate files selected, 0 enabled cases omitted');
    });

    it('rejects an omitted overlap case even when its file also contains ordinary unit coverage', () => {
        const root = createFixture({
            'packages/tests/primary.test.ts': conditionalCases('primary'),
            'packages/tests/mixed.test.ts': [
                'import { it } from \'vitest\';',
                'it(\'ordinary unit coverage\', () => {});',
                'const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === \'1\' ? it : it.skip;',
                'postgresIt.each([1, 2])(\'live overlap %s\', () => {});'
            ].join('\n')
        });
        writeSelectionConfig(root, ['packages/tests/primary.test.ts']);

        const result = runSelection(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('packages/tests/mixed.test.ts');
        expect(result.stderr).toContain('live overlap 1');
        expect(result.stderr).toContain('live overlap 2');
        expect(result.stderr).not.toContain('ordinary unit coverage');
    });

    it('does not mistake fixture text for a PostgreSQL-gated case', () => {
        const root = createFixture({
            'packages/tests/primary.test.ts': conditionalCases('primary'),
            'packages/tests/fixture-reader.test.ts': [
                'import { it, expect } from \'vitest\';',
                'it(\'reads a fixture\', () => expect(\'RALLAR_POSTGRES_INTEGRATION\').toBeTruthy());'
            ].join('\n')
        });
        writeSelectionConfig(root, ['packages/tests/primary.test.ts']);

        const result = runSelection(root);

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('0 enabled cases omitted');
    });

    it('detects an omitted conditional case even when an ordinary case has the same title', () => {
        const root = createFixture({
            'packages/tests/primary.test.ts': conditionalCases('primary'),
            'packages/tests/repeated-title.test.ts': [
                'import { it } from \'vitest\';',
                'it(\'same title\', () => {});',
                'const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === \'1\' ? it : it.skip;',
                'postgresIt(\'same title\', () => {});'
            ].join('\n')
        });
        writeSelectionConfig(root, ['packages/tests/primary.test.ts']);

        const result = runSelection(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('repeated-title.test.ts > same title');
        expect(result.stdout).toContain('1 enabled cases omitted');
    });

    it('fails closed on collection errors instead of accepting an empty case inventory', () => {
        const root = createFixture({
            'packages/tests/primary.test.ts': conditionalCases('primary'),
            'packages/tests/broken.test.ts': 'throw new Error(\'collection failed: RALLAR_POSTGRES_INTEGRATION\');'
        });
        writeSelectionConfig(root, ['packages/tests/primary.test.ts']);

        const result = runSelection(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('collection failed');
    });
});

describe('PostgreSQL execution completeness', { timeout: 35_000 }, () => {
    it('accepts a fully executed suite', () => {
        const result = runFixtureTests('import { it, expect } from \'vitest\'; it(\'executes\', () => expect(2 + 2).toBe(4));');

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('PostgreSQL execution: 1 cases, 0 unexecuted');
    });

    it.each([
        ['declared skip', 'it.skip(\'missing proof\', () => {});'],
        ['runtime skip', 'it(\'missing proof\', (context) => context.skip());'],
        ['todo', 'it.todo(\'missing proof\');']
    ])('fails the native runner for a %s', (_kind, declaration) => {
        const result = runFixtureTests(`import { it } from 'vitest'; ${declaration}`);

        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('missing proof');
        expect(result.stdout + result.stderr).toContain('PostgreSQL execution is incomplete');
    });
});

function createFixture(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-postgres-execution-'));
    fixtureRoots.push(root);
    symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    for (const [name, source] of Object.entries(files)) {
        writeFile(root, name, source);
    }
    return root;
}

function writeFile(root: string, name: string, source: string): void {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
}

function writeSelectionConfig(root: string, include: readonly string[]): void {
    writeFile(root, 'primary.config.mjs', `export default ${JSON.stringify({ test: { include } })};`);
    writeFile(
        root,
        'package.json',
        JSON.stringify({
            scripts: {
                'test:postgres:integration': 'RALLAR_POSTGRES_INTEGRATION=1 vitest run --config primary.config.mjs'
            }
        })
    );
}

function conditionalCases(name: string): string {
    return [
        'import { it } from \'vitest\';',
        'const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === \'1\' ? it : it.skip;',
        `postgresIt.each([1, 2])('${name} %s', () => {});`
    ].join('\n');
}

function runSelection(root: string) {
    return spawnSync(process.execPath, [checkerPath, '--root', root], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
}

function runFixtureTests(source: string) {
    const root = createFixture({ 'proof.test.ts': source });
    writeFile(
        root,
        'vitest.config.mjs',
        `export default ${
            JSON.stringify({
                test: { include: ['proof.test.ts'], reporters: ['dot', reporterPath] }
            })
        };`
    );
    return spawnSync(process.execPath, [path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
}
