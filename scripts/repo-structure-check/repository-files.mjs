import { parse } from '@babel/parser';
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readChangedPaths } from '../repository-changes/read-git-changes.mjs';

export const authoredCodeRoots = Object.freeze([
    'apps',
    'packages',
    'scripts',
    'examples',
    'tests'
]);
export const generatedDirectoryExclusions = Object.freeze([
    '.cache',
    '.deno',
    '.git',
    '.next',
    '.nx',
    '.parcel-cache',
    '.turbo',
    '.vite',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
    'playwright-report',
    'test-results',
    'tmp',
    'tmp-media',
    'vendor'
]);
export const toolMandatedFileExclusions = Object.freeze([
    'cypress.config',
    'jest.config',
    'playwright.config',
    'playwright.exhaustive.config',
    'playwright.full-stack.config',
    'playwright.recipe-console.config',
    'prisma.config',
    'vite.config',
    'vitest.config',
    'vitest.deno.config',
    'vitest.postgres-integration.config'
]);

const authoredCodeExtensions = new Set([
    '.cjs',
    '.css',
    '.cts',
    '.html',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.prisma',
    '.py',
    '.sh',
    '.sql',
    '.ts',
    '.tsx'
]);
const generatedPathPartPattern = /(?:^|[-_.])(?:autogen|codegen|generated)(?:[-_.]|$)|^__generated__$/u;
const generatedFilePattern = /(?:\.generated|\.gen|\.pb)(?:\.d)?\.[cm]?(?:t|j)sx?$/u;

export function readRepositoryFiles(repoRoot, base) {
    const mergeBase = runGit(repoRoot, ['merge-base', base, 'HEAD']).trim();
    const targetFiles = collectTargetFiles(repoRoot);
    const targetRepositoryFiles = collectTargetRepositoryFiles(repoRoot);
    const baseFiles = runGit(repoRoot, ['ls-tree', '-rz', '--name-only', mergeBase])
        .split('\0')
        .filter((file) => isAuthoredCodePath(file));
    const changes = readChanges(repoRoot, mergeBase);
    return {
        mergeBase,
        targetFiles,
        targetRepositoryFiles,
        baseFiles,
        changes,
        readTargetFile: (file) => readFileSync(path.join(repoRoot, file), 'utf8'),
        readBaseFile: (file) => readGitFile(repoRoot, mergeBase, file)
    };
}

function collectTargetRepositoryFiles(repoRoot) {
    return runGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .filter((file) => isReadableRegularFile(path.join(repoRoot, file)))
        .sort(compareCodeUnits);
}

function isReadableRegularFile(absolutePath) {
    let stat;
    try {
        stat = lstatSync(absolutePath);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    return stat.isFile() && (stat.mode & 0o444) !== 0;
}

export function isAuthoredCodePath(file) {
    const normalized = file.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (!authoredCodeRoots.includes(parts[0])) {
        return false;
    }
    if (isExcludedAuthoredNode(normalized)) {
        return false;
    }
    const base = parts.at(-1) ?? '';
    if (!authoredCodeExtensions.has(path.extname(base).toLowerCase())) {
        return false;
    }
    return true;
}

export function isProductionAuthoredCodePath(file) {
    const normalized = file.replaceAll('\\', '/').toLowerCase();
    const parts = normalized.split('/');
    const base = parts.at(-1) ?? '';
    return (
        isAuthoredCodePath(normalized) &&
        !parts.some((part) => ['test', 'tests', '__tests__', 'fixtures', 'mocks'].includes(part)) &&
        !/[.-](?:test|spec|fixture|mock)\.[^.]+$/u.test(base)
    );
}

function collectTargetFiles(repoRoot) {
    return authoredCodeRoots
        .flatMap((root) => collectAuthoredRoot(path.join(repoRoot, root), repoRoot))
        .filter(isAuthoredCodePath)
        .sort(compareCodeUnits);
}

function collectAuthoredRoot(absoluteRoot, repoRoot) {
    try {
        lstatSync(absoluteRoot);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw new Error(`authored code path ${toRelativePath(repoRoot, absoluteRoot)} is not readable`);
    }
    return collectFiles(absoluteRoot, repoRoot);
}

function readChanges(repoRoot, mergeBase) {
    return readChangedPaths(repoRoot, mergeBase)
        .map((change) => {
            const kind = change.status[0];
            return {
                kind,
                source: kind === 'A' ? undefined : (change.oldPath ?? change.path),
                target: kind === 'D' ? undefined : change.path
            };
        })
        .filter((change) => [change.source, change.target].filter(Boolean).some(isAuthoredCodePath))
        .map((change) => ({
            ...change,
            material: isMaterialChange(repoRoot, mergeBase, change)
        }));
}

function isMaterialChange(repoRoot, mergeBase, change) {
    if (change.source === undefined || change.target === undefined) {
        return true;
    }
    const baseSource = readGitFile(repoRoot, mergeBase, change.source);
    const targetSource = readFileSync(path.join(repoRoot, change.target), 'utf8');
    if (baseSource === targetSource) {
        return false;
    }
    const baseTokens = toJavaScriptTokens(change.source, baseSource);
    const targetTokens = toJavaScriptTokens(change.target, targetSource);
    return baseTokens === undefined || targetTokens === undefined || baseTokens !== targetTokens;
}

function toJavaScriptTokens(file, source) {
    if (!/\.[cm]?(?:t|j)sx?$/u.test(file)) {
        return undefined;
    }
    try {
        const plugins = /\.[cm]?tsx?$/u.test(file)
            ? file.endsWith('x')
                ? ['typescript', 'jsx']
                : ['typescript']
            : file.endsWith('x')
            ? ['jsx']
            : [];
        const ast = parse(source, { sourceType: 'module', plugins, tokens: true });
        return JSON.stringify(
            ast.tokens
                .filter((token) => token.type.label !== undefined)
                .map((token) => ({ type: token.type.label, value: token.value }))
        );
    }
    catch {
        return undefined;
    }
}

function collectFiles(current, repoRoot) {
    const relativeDirectory = toRelativePath(repoRoot, current);
    const directoryStat = readAuthoredPathStat(current, relativeDirectory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o555) === 0) {
        throw new Error(`authored code directory ${relativeDirectory} is not readable`);
    }
    let entries;
    try {
        entries = readdirSync(current, { withFileTypes: true });
    }
    catch {
        throw new Error(`authored code directory ${relativeDirectory} is not readable`);
    }
    return entries.flatMap((entry) => {
        const absolutePath = path.join(current, entry.name);
        const relativePath = toRelativePath(repoRoot, absolutePath);
        if (isExcludedAuthoredNode(relativePath)) {
            return [];
        }
        const stat = readAuthoredPathStat(absolutePath, relativePath);
        if (stat.isDirectory()) {
            return collectFiles(absolutePath, repoRoot);
        }
        if (!stat.isFile()) {
            throw new Error(`authored code path ${relativePath} must be a regular file or directory`);
        }
        if ((stat.mode & 0o444) === 0) {
            throw new Error(`authored code file ${relativePath} is not readable`);
        }
        return [relativePath];
    });
}

function isExcludedAuthoredNode(relativePath) {
    if (!isSafeRepositoryRelativeName(relativePath)) {
        return false;
    }
    const parts = relativePath.split('/');
    if (
        parts.some(
            (part) => generatedDirectoryExclusions.includes(part) || generatedPathPartPattern.test(part)
        )
    ) {
        return true;
    }
    const base = parts.at(-1) ?? '';
    if (generatedFilePattern.test(base.toLowerCase())) {
        return true;
    }
    const stem = base.replace(/(?:\.d)?\.[cm]?(?:t|j)sx?$/u, '');
    return toolMandatedFileExclusions.includes(stem);
}

function isSafeRepositoryRelativeName(value) {
    return (
        value !== '' &&
        value === value.replaceAll('\\', '/') &&
        !path.posix.isAbsolute(value) &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    );
}

function readAuthoredPathStat(absolutePath, relativePath) {
    let stat;
    try {
        stat = lstatSync(absolutePath);
    }
    catch {
        throw new Error(`authored code path ${relativePath} is not readable`);
    }
    if (stat.isSymbolicLink()) {
        throw new Error(`authored code path ${relativePath} must not be a symlink`);
    }
    return stat;
}

function readGitFile(repoRoot, revision, file) {
    const result = runGitResult(repoRoot, ['show', `${revision}:${file}`]);
    return result.status === 0 ? result.stdout : undefined;
}

function runGit(repoRoot, args) {
    const result = runGitResult(repoRoot, args);
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
}

function runGitResult(repoRoot, args) {
    return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

const toRelativePath = (repoRoot, file) => path.relative(repoRoot, file).split(path.sep).join('/');
const compareCodeUnits = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
