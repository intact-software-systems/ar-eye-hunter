import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parse } from '@babel/parser';

export const authoredCodeRoots = Object.freeze([
  'apps',
  'packages',
  'scripts',
  'examples',
  'tests',
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
  'vendor',
]);
export const toolMandatedFileExclusions = Object.freeze([
  'cypress.config',
  'jest.config',
  'playwright.config',
  'playwright.exhaustive.config',
  'playwright.full-stack.config',
  'playwright.recipe-console.config',
  'prettier.config',
  'prisma.config',
  'vite.config',
  'vitest.config',
  'vitest.deno.config',
  'vitest.postgres-integration.config',
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
  '.tsx',
]);
const generatedPathPartPattern =
  /(?:^|[-_.])(?:autogen|codegen|generated)(?:[-_.]|$)|^__generated__$/u;
const generatedFilePattern = /(?:\.generated|\.gen|\.pb)(?:\.d)?\.[cm]?(?:t|j)sx?$/u;

export function readRepositoryFiles(repoRoot, base) {
  const mergeBase = runGit(repoRoot, ['merge-base', base, 'HEAD']).trim();
  const targetFiles = collectTargetFiles(repoRoot);
  const baseFiles = runGit(repoRoot, ['ls-tree', '-r', '--name-only', mergeBase])
    .split('\n')
    .filter((file) => isAuthoredCodePath(file));
  const changes = readChanges(repoRoot, mergeBase);
  return {
    mergeBase,
    targetFiles,
    baseFiles,
    changes,
    readTargetFile: (file) => readFileSync(path.join(repoRoot, file), 'utf8'),
    readBaseFile: (file) => readGitFile(repoRoot, mergeBase, file),
  };
}

export function isAuthoredCodePath(file) {
  const normalized = file.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (!authoredCodeRoots.includes(parts[0])) {
    return false;
  }
  if (parts.some((part) => generatedDirectoryExclusions.includes(part))) {
    return false;
  }
  if (parts.some((part) => generatedPathPartPattern.test(part))) {
    return false;
  }
  const base = parts.at(-1) ?? '';
  if (!authoredCodeExtensions.has(path.extname(base).toLowerCase())) {
    return false;
  }
  if (generatedFilePattern.test(base.toLowerCase())) {
    return false;
  }
  const stem = base.replace(/(?:\.d)?\.[cm]?(?:t|j)sx?$/u, '');
  return !toolMandatedFileExclusions.includes(stem);
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
    .flatMap((root) => collectFiles(path.join(repoRoot, root), repoRoot))
    .filter(isAuthoredCodePath)
    .sort(compareCodeUnits);
}

function readChanges(repoRoot, mergeBase) {
  const trackedChanges = runGit(repoRoot, ['diff', '--name-status', '--find-renames', mergeBase])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split('\t');
      const kind = status[0];
      const change =
        kind === 'R' || kind === 'C'
          ? { kind, source: firstPath, target: secondPath }
          : {
              kind,
              source: kind === 'A' ? undefined : firstPath,
              target: kind === 'D' ? undefined : firstPath,
            };
      return {
        ...change,
        material: isMaterialChange(repoRoot, mergeBase, change),
      };
    });
  const untrackedChanges = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .map((target) => ({ kind: 'A', source: undefined, target, material: true }));
  return [...trackedChanges, ...untrackedChanges].filter((change) =>
    [change.source, change.target].filter(Boolean).some(isAuthoredCodePath),
  );
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
        .map((token) => ({ type: token.type.label, value: token.value })),
    );
  } catch {
    return undefined;
  }
}

function collectFiles(current, repoRoot) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      return generatedDirectoryExclusions.includes(entry.name) ||
        generatedPathPartPattern.test(entry.name)
        ? []
        : collectFiles(absolutePath, repoRoot);
    }
    return entry.isFile() ? [toRelativePath(repoRoot, absolutePath)] : [];
  });
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
