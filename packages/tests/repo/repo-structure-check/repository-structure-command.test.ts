import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandPath = path.join(repoRoot, 'scripts/repo-structure-check.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('repository structure command', () => {
    it('reports a new singleton as PR review information without blocking delivery', () => {
        const fixture = createRepository();
        writeFixture(fixture.root, 'scripts/new-owner/only.mjs', 'export const value = true;\n');

        const result = runChecker(fixture.root);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('REVIEW: repository structure');
        expect(result.stdout).toContain('scripts/new-owner [topology.singleton-subtree]');
        expect(result.stdout).toContain('PASS: repository structure');
    });

    it('reports redundant directory chains from the changed tree', () => {
        const fixture = createRepository();
        writeFixture(
            fixture.root,
            'scripts/new-owner/nested/first.mjs',
            'export const first = true;\n'
        );
        writeFixture(
            fixture.root,
            'scripts/new-owner/nested/second.mjs',
            'export const second = true;\n'
        );

        const result = runChecker(fixture.root, ['--base', fixture.base]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
            'scripts/new-owner -> scripts/new-owner/nested [topology.redundant-chain]'
        );
    });

    it('does not parse or enforce historical plan documents', () => {
        const fixture = createRepository();
        writeFixture(fixture.root, 'plans/broken-history.md', '```plan-adaptation-v1\n{\n```\n');
        writeFixture(fixture.root, 'docs/guide.md', 'updated\n');

        const result = runChecker(fixture.root);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('PASS: repository structure');
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('plan-adaptation');
    });

    it('uses a durable semantic exception without GitHub or exact-SHA evidence', () => {
        const fixture = createRepository();
        writeFixture(fixture.root, 'scripts/new-owner/only.mjs', 'export const value = true;\n');
        writeFixture(
            fixture.root,
            'docs/repo-structure-exceptions.json',
            JSON.stringify({
                version: 1,
                exceptions: [
                    {
                        ruleId: 'topology.singleton-subtree',
                        target: 'scripts/new-owner',
                        owner: 'repository maintainers',
                        reviewOrRemovalCondition: 'Remove when this owner gains another source responsibility.'
                    }
                ]
            })
        );

        const result = runChecker(fixture.root);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('scripts/new-owner [topology.singleton-subtree]');
        expect(result.stdout).toContain('PASS: repository structure');
    });

    it('fails closed for a malformed exception registry', () => {
        const fixture = createRepository();
        writeFixture(fixture.root, 'docs/repo-structure-exceptions.json', '{');

        const result = runChecker(fixture.root);

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('docs/repo-structure-exceptions.json contains invalid JSON');
    });

    it.each([
        ['--navigation-evidence', 'owner'],
        ['--plan', 'plans/example.md'],
        ['--base', ''],
        ['--unknown', 'value']
    ])('rejects obsolete or malformed arguments %j', (...args) => {
        const fixture = createRepository();

        const result = runChecker(fixture.root, args);

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
            'usage: node scripts/repo-structure-check.mjs [--base <git-ref>]'
        );
    });
});

function createRepository(): { readonly root: string; readonly base: string; } {
    const root = mkdtempSync(path.join(tmpdir(), 'repository-structure-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Test User']);
    writeFixture(root, 'scripts/existing/first.mjs', 'export const first = true;\n');
    writeFixture(root, 'scripts/existing/second.mjs', 'export const second = true;\n');
    writeFixture(root, 'docs/guide.md', 'initial\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', 'initial']);
    const base = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', base]);
    return { root, base };
}

function runChecker(root: string, args: string[] = []) {
    return spawnSync(process.execPath, [commandPath, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
}

function writeFixture(root: string, relativePath: string, contents: string): void {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
}

function runGit(root: string, args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
