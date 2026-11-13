import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readRevisionSources } from '../../../scripts/repo-style-check/read-revision-sources.mjs';

interface RevisionSource {
    readonly file: string;
    readonly raw: string;
}

const oneMebibyte = 1024 * 1024;
const fixtureRoots: string[] = [];
const isTypeScriptFile = (file: string): boolean => file.endsWith('.ts');

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('revision source reader', () => {
    it('reads what one git show per governed path reads, edge cases included', () => {
        const root = createEdgeCaseRevision();

        const sources = readSources(root, 'HEAD');

        expect(sources).toEqual(readSourcesOneShowPerFile(root, 'HEAD'));
        expect(sources.map((source) => path.relative(root, source.file)).toSorted()).toEqual([
            ' leading space.ts',
            'crlf.ts',
            'dir with space/a b.ts',
            'empty.ts',
            'gitlink.ts',
            'link.ts',
            'over-one-mebibyte.ts'
        ]);
    });

    it('returns a file over 1 MiB in full', () => {
        const root = createEdgeCaseRevision();

        const large = readSources(root, 'HEAD').find((source) => source.file.endsWith('over-one-mebibyte.ts'));

        // The previous reader ran git show under spawnSync's 1 MiB default and dropped this file.
        expect(large?.raw).toBe('x'.repeat(oneMebibyte + 1));
    });

    it('keeps quoted non-ASCII paths out of the governed set, as before', () => {
        const root = createEdgeCaseRevision();

        expect(readSources(root, 'HEAD').some((source) => source.file.includes('bær'))).toBe(false);
    });

    it('reads a tree listing longer than 1 MiB whole', () => {
        const root = createLongListingRevision(9_000);
        const listing = runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);

        expect(Buffer.byteLength(listing)).toBeGreaterThan(oneMebibyte);
        expect(readSources(root, 'HEAD')).toHaveLength(9_000);
    });

    it('fails the way git ls-tree fails for an unknown revision', () => {
        const root = createEdgeCaseRevision();
        const gitError = runGitResult(root, ['ls-tree', '-r', '--name-only', 'no-such-revision']).stderr.trim();

        expect(() => readSources(root, 'no-such-revision')).toThrow(gitError);
    });
});

function readSources(root: string, revision: string): readonly RevisionSource[] {
    return readRevisionSources({ cwd: root, repoRoot: root, revision, isGovernedSourceFile: isTypeScriptFile });
}

function readSourcesOneShowPerFile(root: string, revision: string): RevisionSource[] {
    return runGit(root, ['ls-tree', '-r', '--name-only', revision])
        .split('\n')
        .filter(Boolean)
        .filter((file) => isTypeScriptFile(path.join(root, file)))
        .map((file) => {
            const result = runGitResult(root, ['show', `${revision}:${file}`]);
            return { file: path.join(root, file), raw: result.status === 0 ? result.stdout : undefined };
        })
        .filter((source): source is RevisionSource => source.raw !== undefined);
}

function createEdgeCaseRevision(): string {
    const root = createRepository();
    writeFileSync(path.join(root, 'deleted.ts'), 'export const gone = true;\n');
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'base']);
    const baseCommit = runGit(root, ['rev-parse', 'HEAD']).trim();

    mkdirSync(path.join(root, 'dir with space'));
    writeFileSync(path.join(root, 'crlf.ts'), 'export const sø = \'blåbær ✓\';\r\nexport const two = 2;\r\n');
    writeFileSync(path.join(root, 'empty.ts'), '');
    writeFileSync(path.join(root, 'dir with space/a b.ts'), 'export const spaced = true;\n');
    writeFileSync(path.join(root, ' leading space.ts'), 'export const leading = true;\n');
    writeFileSync(path.join(root, 'blåbær.ts'), 'export const named = true;\n');
    writeFileSync(path.join(root, 'over-one-mebibyte.ts'), 'x'.repeat(oneMebibyte + 1));
    writeFileSync(path.join(root, 'notes.md'), 'not governed\n');
    symlinkSync('dir with space/a b.ts', path.join(root, 'link.ts'));
    rmSync(path.join(root, 'deleted.ts'));
    runGit(root, ['add', '-A']);
    runGit(root, ['update-index', '--add', '--cacheinfo', `160000,${baseCommit},gitlink.ts`]);
    runGit(root, ['commit', '-qm', 'edge cases']);
    return root;
}

function createLongListingRevision(count: number): string {
    const root = createRepository();
    const blob = runGitResult(root, ['hash-object', '-w', '--stdin'], 'export {};\n').stdout.trim();
    const directory = 'nested-directory/'.repeat(7);
    const entries = Array.from({ length: count }, (_, index) => `100644 ${blob}\t${directory}module-${index}.ts\n`);
    runGitResult(root, ['update-index', '--index-info'], entries.join(''));
    runGit(root, ['commit', '-qm', 'long listing']);
    return root;
}

function createRepository(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-revision-sources-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '-q']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Test User']);
    return root;
}

function runGit(root: string, args: readonly string[]): string {
    const result = runGitResult(root, args);
    if (result.status !== 0) {
        throw new Error(result.stderr);
    }
    return result.stdout;
}

function runGitResult(root: string, args: readonly string[], input?: string) {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: Infinity });
}
