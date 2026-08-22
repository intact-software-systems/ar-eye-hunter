import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandPath = path.join(repoRoot, 'scripts/validation-evidence.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('validation evidence command', () => {
    it('creates a transient PR-bound v2 artifact without a workflow or review ledger', () => {
        const root = createGitFixture();
        const head = runGit(root, ['rev-parse', 'HEAD']).trim();
        const output = path.join(root, 'validation-evidence-v2.json');

        const result = run([
            'create',
            '--repo-root',
            root,
            '--repository',
            'example/project',
            '--pull-request-number',
            '222',
            '--workflow-path',
            '.github/workflows/branch-release-gate.yml',
            '--run-id',
            '4123',
            '--run-attempt',
            '2',
            '--head',
            head,
            '--completed-at',
            '2026-08-13T09:08:00.000Z',
            '--output',
            output
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
            schemaVersion: 'validation-evidence-v2',
            repository: 'example/project',
            pullRequestNumber: 222,
            workflow: {
                path: '.github/workflows/branch-release-gate.yml',
                runId: 4123,
                runAttempt: 2
            },
            head,
            completedAt: '2026-08-13T09:08:00.000Z'
        });
        expect(readFileSync(output, 'utf8')).not.toMatch(/review|plan|ledger/iu);
    });

    it('concludes from local job results without App or receipt inputs', () => {
        const result = run([
            'conclude',
            '--governance-result',
            'success',
            '--selection-result',
            'success',
            '--reuse',
            'false',
            '--release-result',
            'success',
            '--publication-result',
            'success'
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('PASS: Branch Release Gate result');
    });

    it('fails controlled validation before writing malformed evidence', () => {
        const root = createGitFixture();
        const output = path.join(root, 'validation-evidence-v2.json');

        const result = run([
            'create',
            '--repo-root',
            root,
            '--repository',
            'example/project',
            '--pull-request-number',
            'not-a-number',
            '--workflow-path',
            '.github/workflows/branch-release-gate.yml',
            '--run-id',
            '4123',
            '--run-attempt',
            '2',
            '--head',
            runGit(root, ['rev-parse', 'HEAD']).trim(),
            '--completed-at',
            '2026-08-13T09:08:00.000Z',
            '--output',
            output
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('pull request number must be a positive integer');
        expect(existsSync(output)).toBe(false);
    });
});

function createGitFixture(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'validation-evidence-cli-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main', '--quiet']);
    runGit(root, ['config', 'user.name', 'Validation Evidence Test']);
    runGit(root, ['config', 'user.email', 'validation-evidence@example.invalid']);
    writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', 'fixture']);
    return root;
}

function run(arguments_: readonly string[]) {
    return spawnSync(process.execPath, [commandPath, ...arguments_], { encoding: 'utf8' });
}

function runGit(root: string, arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
