import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

const checkerPath = path.join(process.cwd(), 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

export interface SplitFixture {
  readonly root: string;
  readonly mergeBase: string;
  readonly sourcePath: string;
  readonly sourceBlob: string;
  readonly targetPaths: readonly string[];
}

interface CreateSplitFixtureInput {
  readonly baseFindings: readonly string[];
  readonly targetFindings: readonly (readonly string[])[];
  readonly targetPaths?: readonly string[];
  readonly manifest?: boolean;
}

interface LineageOverride {
  readonly mergeBase?: string;
  readonly sourcePath?: string;
  readonly sourceBlob?: string;
  readonly targets?: readonly string[];
}

interface RunChangedCheckerInput {
  readonly root: string;
  readonly mergeBase: string;
  readonly targetReference?: 'HEAD' | 'WORKTREE';
  readonly nodeArguments?: readonly string[];
}

export function cleanupStructuralLineageFixtures(): void {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export function createSplitFixture(input: CreateSplitFixtureInput): SplitFixture {
  const sourcePath = 'apps/example/legacy-owner.ts';
  const root = createGitFixture({ [sourcePath]: input.baseFindings.join('') });
  commitAll(root, 'base');
  const mergeBase = readGit(root, ['rev-parse', 'HEAD']).trim();
  const sourceBlob = readBlob(root, mergeBase, sourcePath);
  const targetPaths = input.targetPaths ?? input.targetFindings.map((_, index) => `apps/example/target-${letter(index)}.ts`);
  writeFixture(
    root,
    sourcePath,
    targetPaths.map((targetPath) => `export * from './${path.basename(targetPath, path.extname(targetPath))}';`).join('\n'),
  );
  targetPaths.forEach((targetPath, index) => {
    writeFixture(root, targetPath, input.targetFindings[index]?.join('') ?? '');
  });
  const fixture = { root, mergeBase, sourcePath, sourceBlob, targetPaths };
  if (input.manifest === true) {
    writeLineageManifest(root, [lineage(fixture)]);
  }
  commitAll(root, 'split owner');
  return fixture;
}

export function lineage(fixture: SplitFixture, override: LineageOverride = {}) {
  return {
    mergeBase: override.mergeBase ?? fixture.mergeBase,
    source: {
      path: override.sourcePath ?? fixture.sourcePath,
      blob: override.sourceBlob ?? fixture.sourceBlob,
    },
    targets: override.targets ?? fixture.targetPaths,
  };
}

export function writeLineageManifest(root: string, lineages: readonly unknown[]): void {
  writeLineageManifestAt(root, 'plans/repo-style-lineages/example.json', lineages);
}

export function writeLineageManifestAt(root: string, relativePath: string, lineages: readonly unknown[]): void {
  writeFixture(root, relativePath, `${JSON.stringify({ version: 1, lineages }, null, 2)}\n`);
}

export function writeBoundarySummaryVariantLoader(root: string): string {
  const loaderPath = path.join(root, '.test-support/repository-scan-loader.mjs');
  const fakeScannerSource = [
    "import path from 'node:path';",
    'export function isProductionCodeFile(file) {',
    '  return /\\/(?:apps|packages)\\/.*\\.[cm]?[jt]sx?$/u.test(file);',
    '}',
    // The changed-style checker also asks which sources are tests and which rules are enforced on
    // them. This fixture only produces production paths, so both answers are the production ones.
    'export function isTestSourceFile() {',
    '  return false;',
    '}',
    'export function isTestEnforcedFinding() {',
    '  return true;',
    '}',
    'export async function collectProductionSources(roots) {',
    "  return [{ file: path.join(roots[0], 'apps/example/target-a.ts'), raw: 'target' }];",
    '}',
    'export function scanProductionSources({ sources }) {',
    "  const isBase = sources.some((source) => source.file.endsWith('/legacy-owner.ts'));",
    '  const file = sources[0].file;',
    '  const messages = isBase',
    '    ? Array.from(',
    '        { length: 6 },',
    '        (_, index) => `Review unknown at line ${index + 1}: base detail.`,',
    '      )',
    '    : [',
    "        '... and 5 additional opaque occurrences. Different boundary variant.',",
    "        '... and 5 additional unknown occurrences. Exact boundary summary.',",
    '      ];',
    '  return {',
    "    findings: messages.map((message) => ({ file, ruleId: 'boundary.unknown', message })),",
    '  };',
    '}',
  ].join('\n');
  writeFixture(
    root,
    '.test-support/repository-scan-loader.mjs',
    [
      'export async function load(url, context, nextLoad) {',
      "  if (url.endsWith('/scripts/repo-style-check/repository-scan.mjs')) {",
      '    return {',
      "      format: 'module',",
      '      shortCircuit: true,',
      `      source: ${JSON.stringify(fakeScannerSource)},`,
      '    };',
      '  }',
      '  return nextLoad(url, context);',
      '}',
    ].join('\n'),
  );
  return loaderPath;
}

function createGitFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-style-lineage-fixture-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Repo Style Test']);
  runGit(root, ['config', 'user.email', 'repo-style@example.invalid']);
  for (const [relativePath, source] of Object.entries(files)) {
    writeFixture(root, relativePath, source);
  }
  return root;
}

export function writeFixture(root: string, relativePath: string, source: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

export function commitAll(root: string, message: string): void {
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', message]);
}

export function readBlob(root: string, revision: string, relativePath: string): string {
  return readGit(root, ['rev-parse', `${revision}:${relativePath}`]).trim();
}

export function runChangedChecker(input: RunChangedCheckerInput) {
  const targetReference = input.targetReference ?? 'HEAD';
  return spawnSync(process.execPath, [...(input.nodeArguments ?? []), checkerPath, input.mergeBase, targetReference], {
    cwd: input.root,
    encoding: 'utf8',
  });
}

export function runGit(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function readGit(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

export function overParameterizedSource(label: string, extraParameters = 0): string {
  const name = label.replaceAll('-', '');
  const parameters = Array.from({ length: 4 + extraParameters }, (_, index) => `p${index}: string`);
  return `function ${name}(${parameters.join(', ')}): string {\n  return '';\n}\n`;
}

export function unknownSource(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `const ${prefix}${index}: unknown = ${index};`).join('\n');
}

function letter(index: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + index);
}
