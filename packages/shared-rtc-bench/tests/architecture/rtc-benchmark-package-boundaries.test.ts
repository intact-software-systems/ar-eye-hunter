import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const packageRoot = path.join(repoRoot, 'packages/shared-rtc-bench');
const benchmarkPackageName = '@ar-eye-hunter/shared-rtc-bench';
const approvedRepositoryImportPrefixes = ['@shared/', '@shared-web/', '@shared-server/'] as const;
const approvedExternalImports = new Set([
  '@playwright/test',
  '@std/path',
  'graphology',
  'postgres',
  'vitest',
]);

function filesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['node_modules', 'dist', 'coverage'].includes(entry.name)) return [];
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const fromOrDynamicImports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)];
  const sideEffectImports = [...source.matchAll(/\bimport\s+(['"])([^'"]+)\1/g)];
  return [...fromOrDynamicImports, ...sideEffectImports].map((match) => match[2]);
}

function isPackageLocalImport(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const withoutQuery = specifier.split('?')[0];
  const relativeTarget = path.relative(packageRoot, path.resolve(path.dirname(file), withoutQuery));
  return (
    relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))
  );
}

function isApprovedImport(file: string, specifier: string): boolean {
  if (isPackageLocalImport(file, specifier)) return true;
  if (
    specifier === benchmarkPackageName ||
    specifier.startsWith(`${benchmarkPackageName}/`) ||
    specifier.startsWith('node:')
  ) {
    return true;
  }
  if (approvedRepositoryImportPrefixes.some((prefix) => specifier.startsWith(prefix))) return true;
  return approvedExternalImports.has(specifier);
}

function unapprovedImports(file: string): string[] {
  return importSpecifiers(fs.readFileSync(file, 'utf8'))
    .filter((specifier) => !isApprovedImport(file, specifier))
    .map((specifier) => `${path.relative(repoRoot, file)} -> ${specifier}`);
}

function isBenchmarkPackageSpecifier(specifier: string): boolean {
  return specifier === benchmarkPackageName || specifier.startsWith(`${benchmarkPackageName}/`);
}

function importsBenchmarkPackage(file: string): boolean {
  return importSpecifiers(fs.readFileSync(file, 'utf8')).some((specifier) => {
    if (isBenchmarkPackageSpecifier(specifier)) return true;
    if (!specifier.startsWith('.')) return false;
    const relativeTarget = path.relative(packageRoot, path.resolve(path.dirname(file), specifier));
    return (
      relativeTarget === '' ||
      (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))
    );
  });
}

describe('shared RTC benchmark package boundaries', () => {
  it('enforces the exact direct-import allowlist and reverse-import package prefix', () => {
    const packageFile = path.join(packageRoot, 'tests/architecture/example.test.ts');
    expect(
      [
        './package-owner.ts',
        '@ar-eye-hunter/shared-rtc-bench/baseline/contracts',
        '@shared/contracts/example.ts',
        '@shared-web/browser/example.ts',
        '@shared-server/runtime-state/example.ts',
        'node:path',
        '@playwright/test',
        '@std/path',
        'graphology',
        'postgres',
        'vitest',
      ].every((specifier) => isApprovedImport(packageFile, specifier)),
    ).toBe(true);
    expect(
      [
        '../../../scripts/perf/example.ts',
        '../../../apps/api-v1/example.ts',
        '@shared-graph/example.ts',
        '@shared-test/example.ts',
        '@ar-eye-hunter/another-package',
      ].every((specifier) => !isApprovedImport(packageFile, specifier)),
    ).toBe(true);
    expect(isBenchmarkPackageSpecifier('@ar-eye-hunter/shared-rtc-bench/internal')).toBe(true);
  });

  it('owns every RTC/WebRTC performance source outside scripts', () => {
    const oldSources = filesBelow(path.join(repoRoot, 'scripts/perf'))
      .map((file) => path.relative(repoRoot, file))
      .filter((file) => /(^|\/)(rtc|webrtc)/.test(file));
    expect(oldSources, `old RTC/WebRTC performance sources:\n${oldSources.join('\n')}`).toEqual([]);
  });

  it('has no prohibited package imports or reverse product imports', () => {
    const oldSources = filesBelow(path.join(repoRoot, 'scripts/perf')).filter((file) =>
      /(^|\/)(rtc|webrtc)/.test(path.relative(repoRoot, file)),
    );
    const packageViolations = [...filesBelow(packageRoot), ...oldSources]
      .filter((file) => /\.[cm]?[jt]s$/.test(file))
      .flatMap(unapprovedImports);
    const reverseImports = [path.join(repoRoot, 'apps'), path.join(repoRoot, 'packages')]
      .flatMap(filesBelow)
      .filter((file) => !file.startsWith(packageRoot) && /\.[cm]?[jt]s$/.test(file))
      .filter(importsBenchmarkPackage)
      .map((file) => path.relative(repoRoot, file));
    expect([...packageViolations, ...reverseImports]).toEqual([]);
  });
});
