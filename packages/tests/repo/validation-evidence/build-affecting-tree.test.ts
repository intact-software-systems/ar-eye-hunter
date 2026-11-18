import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeBuildAffectingTreeDigest } from '../../../../scripts/validation-evidence/build-affecting-tree.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('build-affecting tree', () => {
    it.each([
        ['ordinary documentation', 'docs/guide.md'],
        ['application documentation', 'apps/example/README.md'],
        ['package documentation', 'packages/example/docs/architecture.md'],
        ['historical plan documentation', 'plans/example-plan.md'],
        [
            'RTC performance observation archive',
            'performance-observations/rtc-b05/2026/08/27/20260827T010203Z-123456789abc-e2-browser-gh42-a1.zip'
        ],
        ['RTC performance observation index', 'performance-observations/rtc-b05/index.jsonl'],
        [
            'RTC-B06 performance observation archive',
            'performance-observations/rtc-b06/2026/08/30/20260830T100000Z-123456789abc-e3-memory-gh42-a1.zip'
        ],
        ['RTC-B06 performance observation index', 'performance-observations/rtc-b06/index.jsonl']
    ])('ignores changed %s', (_name, changedPath) => {
        const fixture = createGitFixture();
        const before = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });
        commit(fixture, `change ${changedPath}`, { [changedPath]: `changed ${changedPath}\n` });

        const after = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });

        expect(after).toBe(before);
    });

    it.each([
        ['production code', 'apps/example/main.ts'],
        ['tests', 'packages/tests/example/main.test.ts'],
        ['workflows', '.github/workflows/ci.yml'],
        ['custom actions', '.github/actions/example/action.yml'],
        ['agent contracts', 'AGENTS.md'],
        ['package metadata', 'package.json'],
        ['lockfiles', 'package-lock.json'],
        ['TypeScript configuration', 'tsconfig.json'],
        ['Docker Compose configuration', 'docker-compose.yml'],
        ['root build scripts', 'no-js-files-outside-dist.sh'],
        ['test-consumed API reference', 'docs/rallar-api-reference.md'],
        ['test-consumed package documentation', 'packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md'],
        ['test-consumed pull request template', '.github/PULL_REQUEST_TEMPLATE.md']
    ])('changes for changed %s', (_name, changedPath) => {
        const fixture = createGitFixture();
        const before = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });
        commit(fixture, `change ${changedPath}`, { [changedPath]: `changed ${changedPath}\n` });

        const after = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });

        expect(after).not.toBe(before);
    });

    it('reads a tree whose listing is larger than one mebibyte', () => {
        const fixture = createGitFixture();
        const before = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });
        commitIndexedPaths(fixture, 8_000);
        const listingBytes = Buffer.byteLength(runGitUnbounded(fixture, ['ls-tree', '-r', '-z', 'HEAD']));

        const after = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });

        expect(listingBytes).toBeGreaterThan(1024 * 1024);
        expect(after).not.toBe(before);
    });
});

/**
 * Indexes `count` paths over one blob without writing a file each, then commits them: a listing of that many
 * entries, which is what the digest reads, costs one git call to build.
 */
function commitIndexedPaths(root: string, count: number): void {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, encoding: 'utf8', input: 'x\n' })
        .trim();
    const entries = Array.from(
        { length: count },
        (_, index) => `100644 ${blob}\tpackages/example/${'directory-'.repeat(8)}${index}/module.ts`
    );
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: `${entries.join('\n')}\n` });
    runGit(root, ['commit', '--quiet', '-m', `index ${count} paths`]);
}

function createGitFixture(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'build-affecting-tree-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main', '--quiet']);
    runGit(root, ['config', 'user.name', 'Build Tree Test']);
    runGit(root, ['config', 'user.email', 'build-tree@example.invalid']);
    commit(root, 'base', {
        'apps/example/main.ts': 'export const value = 1;\n',
        'packages/tests/example/main.test.ts': 'export {};\n',
        '.github/workflows/ci.yml': 'name: CI\n',
        'package.json': '{"name":"fixture"}\n',
        'package-lock.json': '{"lockfileVersion":3}\n',
        'plans/example-plan.md': '# Historical plan\n',
        'docs/guide.md': 'original prose\n'
    });
    return root;
}

function commit(root: string, message: string, files: Readonly<Record<string, string>>): void {
    for (const [repositoryPath, source] of Object.entries(files)) {
        const filePath = path.join(root, repositoryPath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, source);
    }
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', message]);
}

function runGit(root: string, arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}

function runGitUnbounded(root: string, arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', maxBuffer: Number.POSITIVE_INFINITY });
}
