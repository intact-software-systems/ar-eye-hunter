import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { printReport } from '../../../scripts/legacy-review/candidate-report.mjs';
import { readRetainedLegacyRegistry } from '../../../scripts/legacy-review/retained-legacy-registry.mjs';
import { validateRetainedLegacy } from '../../../scripts/legacy-review/validate-retained-legacy.mjs';

const repoRoot = process.cwd();
const reviewLegacyPath = path.join(repoRoot, 'scripts/review-legacy.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('retained production legacy policy', () => {
  it.each(['removed', 'resolved', 'minimized-boundary'])(
    'accepts a directly reviewed %s disposition without a registry entry',
    (disposition) => {
      expect(
        validateRetainedLegacy({
          items: [{ path: 'packages/example/legacy.ts', symbol: 'legacyRoute', disposition }],
          registryEntries: [],
        }),
      ).toEqual([]);
    },
  );

  it('rejects newly retained production legacy without a durable exception', () => {
    expect(
      validateRetainedLegacy({
        items: [
          {
            path: 'packages/example/legacy.ts',
            symbol: 'legacyRoute',
            disposition: 'retained',
          },
        ],
        registryEntries: [],
      }),
    ).toEqual([
      'retained production legacy requires a registry entry: packages/example/legacy.ts#legacyRoute',
    ]);
  });

  it('accepts already registered retained production legacy without PR or SHA metadata', () => {
    const registry = readRetainedLegacyRegistry(registrySource());

    expect(registry.issues).toEqual([]);
    expect(
      validateRetainedLegacy({
        items: [
          {
            path: 'packages/example/legacy.ts',
            symbol: 'legacyRoute',
            disposition: 'retained',
          },
        ],
        registryEntries: registry.entries,
      }),
    ).toEqual([]);
    expect(registry.entries[0]).not.toHaveProperty('pullNumber');
    expect(registry.entries[0]).not.toHaveProperty('reviewer');
    expect(registry.entries[0]).not.toHaveProperty('sha');
  });

  it('rejects malformed or duplicated semantic registry entries', () => {
    const source = `${registrySource()}\n${registrySource().split('## Retained exceptions\n')[1]}`;
    const registry = readRetainedLegacyRegistry(source);

    expect(registry.issues).toContain(
      'retained legacy registry duplicates packages/example/legacy.ts#legacyRoute',
    );
  });
});

describe('changed production legacy review command', () => {
  it('reports heuristic changed-production facts without IDs, digests, or a final ledger', () => {
    const fixture = createGitFixture({
      'packages/example/src/compatibility-route.ts': [
        "export { createCanonicalRoute as createLegacyRoute } from './canonical-route.ts';",
        "export const fallbackMode = 'legacy';",
      ].join('\n'),
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('REVIEW: changed production legacy candidate');
    expect(result.stdout).toContain('compatibility vocabulary');
    expect(result.stdout).toContain('compatibility export alias');
    expect(result.stdout).toContain('feature flag or mode retaining a predecessor');
    expect(result.stdout).not.toContain('::warning');
    expect(result.stdout).not.toMatch(/production-legacy-candidate-|REPORT-SHA256|final ledger/iu);
  });

  it('emits non-blocking GitHub warnings for heuristic candidates in Actions', () => {
    const fixture = createGitFixture({
      'packages/example/src/compatibility-route.ts':
        "export { createCanonicalRoute as createLegacyRoute } from './canonical-route.ts';\n",
    });

    const result = runLegacyReview(fixture, [], { GITHUB_ACTIONS: 'true' });

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain(
      '::warning file=packages/example/src/compatibility-route.ts,line=1,' +
        'title=Changed production legacy heuristic candidate::',
    );
    expect(result.stdout).toContain('Heuristic candidate');
  });

  it('escapes scanner-derived warning properties and messages', () => {
    const output = captureReportOutput(
      [
        {
          path: 'packages/example/src/compatibility%2C:route.ts',
          line: 7,
          symbol: 'legacy%:\r\n,route',
          reason: 'compatibility%,\r\n:reason',
        },
      ],
      true,
    );

    expect(output).toContain(
      '::warning file=packages/example/src/compatibility%252C%3Aroute.ts,line=7,' +
        'title=Changed production legacy heuristic candidate::' +
        'legacy%25%3A%0D%0A%2Croute — compatibility%25%2C%0D%0A%3Areason. ' +
        'Heuristic candidate; inspect the changed production call path.',
    );
  });

  it('caps GitHub candidate annotations and reports overflow', () => {
    const candidates = Array.from({ length: 23 }, (_, index) => ({
      path: `packages/example/src/legacy-route-${index + 1}.ts`,
      line: index + 1,
      symbol: `legacyRoute${index + 1}`,
      reason: 'compatibility vocabulary',
    }));

    const output = captureReportOutput(candidates, true);
    const warnings = output.split('\n').filter((line) => line.startsWith('::warning'));

    expect(warnings).toHaveLength(21);
    expect(warnings.filter((line) => line.includes('file='))).toHaveLength(20);
    expect(warnings.at(-1)).toContain('3 additional heuristic candidates');
    expect(warnings.at(-1)).toContain('npm run check%3Aretained-legacy');
  });

  it('does not let plain candidate values inject GitHub workflow commands', () => {
    const output = captureReportOutput(
      [
        {
          path: 'packages/example/src/legacy-route.ts\n::warning file=forged.ts::forged',
          line: 1,
          symbol: 'legacyRoute',
          reason: 'compatibility vocabulary',
        },
      ],
      true,
    );
    const warnings = output.split('\n').filter((line) => line.startsWith('::warning'));

    expect(warnings).toHaveLength(1);
    expect(output).toContain(
      'CANDIDATE packages/example/src/legacy-route.ts\\n::warning file=forged.ts::forged:1',
    );
  });

  it('keeps tests and ordinary governance tooling outside production legacy review', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.test.ts': 'export const legacy = true;\n',
      'scripts/legacy-review.mjs': 'export const legacyReview = true;\n',
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no changed production legacy candidates');
  });

  it('validates an explicitly supplied durable registry without GitHub access', () => {
    const fixture = createGitFixture({
      'packages/example/src/current-route.ts': 'export const route = true;\n',
    });
    writeFileSync(path.join(fixture.root, 'registry.md'), registrySource());

    const result = runLegacyReview(fixture, ['--registry', 'registry.md']);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: retained production legacy registry is valid');
  });

  it('fails closed for invalid Git revisions with a controlled diagnostic', () => {
    const fixture = createGitFixture({
      'packages/example/src/current-route.ts': 'export const route = true;\n',
    });

    const result = spawnSync(process.execPath, [reviewLegacyPath, 'not-a-commit', fixture.head], {
      cwd: fixture.root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: base reference does not resolve to a commit');
    expect(result.stderr).not.toContain('Error:');
  });
});

function registrySource(): string {
  return `# Production Legacy Exception Registry

## Retained exceptions

### packages/example/legacy.ts#legacyRoute

- Path: packages/example/legacy.ts
- Symbol: legacyRoute
- Purpose: Preserve an external compatibility route.
- Canonical owner: packages/example/current.ts#currentRoute
- Consumer dependency: Existing clients still call the old route.
- Why removal is unsafe: The client migration has not completed.
- Minimization: The old route delegates directly to the canonical route.
- Compatibility tests: packages/example/legacy.test.ts
- Named owner: example maintainers
- Review or removal condition: Remove after all clients migrate.
`;
}

function createGitFixture(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-review-fixture-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main', '--quiet']);
  runGit(root, ['config', 'user.name', 'Legacy Review Test']);
  runGit(root, ['config', 'user.email', 'legacy-review@example.test']);
  writeFixture(
    root,
    'packages/example/src/canonical-route.ts',
    'export const runCanonicalRoute = () => 200;\n',
  );
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  for (const [file, content] of Object.entries(files)) {
    writeFixture(root, file, content);
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'candidate']);
  return { root, base, head: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function runLegacyReview(
  fixture: { readonly root: string; readonly base: string; readonly head: string },
  options: readonly string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [reviewLegacyPath, fixture.base, fixture.head, ...options], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function captureReportOutput(
  candidates: readonly {
    readonly path: string;
    readonly line: number;
    readonly symbol: string;
    readonly reason: string;
  }[],
  githubActions: boolean,
): string {
  const lines: string[] = [];
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((value) => {
    lines.push(String(value));
  });
  try {
    printReport({ candidates }, { githubActions });
  } finally {
    consoleLog.mockRestore();
  }
  return lines.join('\n');
}

function writeFixture(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runGit(root: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
