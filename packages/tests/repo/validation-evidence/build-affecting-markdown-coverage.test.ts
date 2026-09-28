import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    exactBuildContractPaths,
    isBuildAffectingPath
} from '../../../../scripts/validation-evidence/build-affecting-tree.mjs';

interface MarkdownReference {
    readonly testPath: string;
    readonly markdownPath: string;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scannerTestPath = path.relative(repoRoot, fileURLToPath(import.meta.url));
const testSourcePattern = /^(?:packages\/tests\/|packages\/shared-rtc-bench\/tests\/|apps\/[^/]+\/test\/).+\.[cm]?[jt]sx?$/u;
const markdownPattern = /\.mdx?$/u;
const stringLiteralPattern = /(['"`])((?:(?!\1)[^\\\n]|\\.)*?)\1/gu;
// These tests name README.md only for a file they write into a temporary repository.
const fixtureOnlyMarkdownReferences: readonly MarkdownReference[] = [
    { testPath: 'packages/tests/hetzner/distributed-recipe-workflow.test.ts', markdownPath: 'README.md' },
    { testPath: 'packages/tests/repo/repo-style-reviewed-dispositions.test.ts', markdownPath: 'README.md' }
];

describe('build-affecting markdown coverage', () => {
    it('treats every tracked markdown file a test names by path as build-affecting', () => {
        const uncovered = readTestMarkdownReferences(readTrackedPaths())
            .filter((reference) => !isBuildAffectingPath(reference.markdownPath))
            .filter((reference) => !fixtureOnlyMarkdownReferences.some((fixture) => isSameReference(fixture, reference)))
            .map((reference) => `${reference.markdownPath} named by ${reference.testPath}`);

        expect(
            uncovered,
            'add each path to exactBuildContractPaths, or to fixtureOnlyMarkdownReferences when the test only writes a fixture'
        ).toEqual([]);
    });

    it('keeps each fixture-only exemption tied to a current test reference', () => {
        const references = readTestMarkdownReferences(readTrackedPaths());

        const stale = fixtureOnlyMarkdownReferences.filter(
            (fixture) => !references.some((reference) => isSameReference(fixture, reference))
        );

        expect(stale).toEqual([]);
    });

    it('lists only exact build contract paths that exist in the repository', () => {
        const trackedPaths = new Set(readTrackedPaths());

        expect([...exactBuildContractPaths].filter((contractPath) => !trackedPaths.has(contractPath))).toEqual([]);
    });

    it.each([
        {
            name: 'relative to the test file',
            testPath: 'apps/example/test/a.test.ts',
            source: 'new URL("../../../docs/a.md", import.meta.url)',
            expected: ['docs/a.md']
        },
        {
            name: 'relative to the repository root',
            testPath: 'packages/tests/a.test.ts',
            source: 'readRepo("docs/a.md")',
            expected: ['docs/a.md']
        },
        {
            name: 'relative to a package root',
            testPath: 'packages/tests/a.test.ts',
            source: 'path.join(packageRoot, "docs/guide.md")',
            expected: ['packages/example/docs/guide.md']
        },
        {
            name: 'as a bare name in the nearest ancestor',
            testPath: 'packages/example/tests/a.test.ts',
            source: 'path.join(packageRoot, "README.md")',
            expected: ['packages/example/README.md']
        },
        {
            name: 'inside a command line',
            testPath: 'packages/tests/a.test.ts',
            source: '`node check.mjs --registry docs/a.md`',
            expected: ['docs/a.md']
        },
        {
            name: 'only when a tracked file matches',
            testPath: 'packages/tests/a.test.ts',
            source: 'writeFileSync("docs/fixture.md", "")',
            expected: []
        },
        {
            name: 'only outside interpolated templates',
            testPath: 'packages/tests/a.test.ts',
            source: '`${root}/docs/a.md`',
            expected: []
        }
    ])('resolves a markdown path $name', ({ testPath, source, expected }) => {
        const trackedMarkdownPaths = new Set([
            'README.md',
            'docs/a.md',
            'packages/example/README.md',
            'packages/example/docs/guide.md'
        ]);

        expect(computeMarkdownReferences(testPath, source, trackedMarkdownPaths)).toEqual(expected);
    });
});

function isSameReference(left: MarkdownReference, right: MarkdownReference): boolean {
    return left.testPath === right.testPath && left.markdownPath === right.markdownPath;
}

function computeMarkdownReferences(
    testPath: string,
    source: string,
    trackedMarkdownPaths: ReadonlySet<string>
): readonly string[] {
    const tokens = [...source.matchAll(stringLiteralPattern)]
        .filter((match) => !match[2].includes('${'))
        .flatMap((match) => match[2].split(/\s+/u))
        .filter((token) => markdownPattern.test(token));
    return [...new Set(tokens.flatMap((token) => resolveMarkdownToken(testPath, token, trackedMarkdownPaths)))];
}

function resolveMarkdownToken(
    testPath: string,
    token: string,
    trackedMarkdownPaths: ReadonlySet<string>
): readonly string[] {
    if (token.startsWith('./') || token.startsWith('../')) {
        const resolved = path.posix.join(path.posix.dirname(testPath), token);
        return trackedMarkdownPaths.has(resolved) ? [resolved] : [];
    }
    if (token.includes('/')) {
        return trackedMarkdownPaths.has(token)
            ? [token]
            : [...trackedMarkdownPaths].filter((markdownPath) => markdownPath.endsWith(`/${token}`));
    }
    return resolveNearestAncestorPath(testPath, token, trackedMarkdownPaths);
}

function resolveNearestAncestorPath(
    testPath: string,
    fileName: string,
    trackedMarkdownPaths: ReadonlySet<string>
): readonly string[] {
    for (let directory = path.posix.dirname(testPath); directory !== '.'; directory = path.posix.dirname(directory)) {
        const candidate = `${directory}/${fileName}`;
        if (trackedMarkdownPaths.has(candidate)) {
            return [candidate];
        }
    }
    return trackedMarkdownPaths.has(fileName) ? [fileName] : [];
}

function readTestMarkdownReferences(trackedPaths: readonly string[]): readonly MarkdownReference[] {
    const trackedMarkdownPaths = new Set(trackedPaths.filter((trackedPath) => markdownPattern.test(trackedPath)));
    return trackedPaths
        .filter((trackedPath) => testSourcePattern.test(trackedPath) && trackedPath !== scannerTestPath)
        .flatMap((testPath) =>
            computeMarkdownReferences(testPath, readFileSync(path.join(repoRoot, testPath), 'utf8'), trackedMarkdownPaths)
                .map((markdownPath) => ({ testPath, markdownPath }))
        );
}

// A tracked file deleted in the working tree is gone from the tree this test validates.
function readTrackedPaths(): readonly string[] {
    return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\0')
        .filter((trackedPath) => trackedPath !== '' && existsSync(path.join(repoRoot, trackedPath)));
}
