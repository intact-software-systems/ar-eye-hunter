import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const reviewLegacyPath = path.join(repoRoot, 'scripts/review-legacy.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('changed production legacy review', () => {
  it('reports stable candidate evidence for legacy vocabulary and compatibility exports', () => {
    const fixture = createGitFixture({
      'packages/example/src/compatibility-route.ts': [
        "export { createCanonicalRoute as createLegacyRoute } from './canonical-route.ts';",
        "export const fallbackMode = 'legacy';",
      ].join('\n'),
    });

    const first = runLegacyReview(fixture);
    const second = runLegacyReview(fixture);

    expect(first.status, first.stdout).toBe(0);
    expect(first.stdout).toContain('WARN: legacy candidate review is heuristic evidence');
    expect(first.stdout).toContain('compatibility vocabulary');
    expect(first.stdout).toContain('compatibility export alias');
    expect(first.stdout).toContain('feature flag or mode retaining a predecessor');
    expect(first.stdout).toContain('packages/example/src/compatibility-route.ts:1');
    expect(candidateLines(first.stdout)).toEqual(candidateLines(second.stdout));
  });

  it('reports parallel predecessor paths and duplicate route targets only in changed production files', () => {
    const fixture = createGitFixture({
      'packages/example/src/old-route.ts':
        "export { runCanonicalRoute } from './canonical-route.ts';\n",
      'packages/example/src/new-route.ts':
        "export { runCanonicalRoute } from './canonical-route.ts';\n",
      'packages/example/src/route.test.ts': 'const legacy = true;\n',
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('parallel old/new entry points');
    expect(result.stdout).toContain('duplicate adapter or route target');
    expect(result.stdout).not.toContain('packages/example/src/route.test.ts');
  });

  it('reports a clean scan as inconclusive rather than proof that no legacy exists', () => {
    const fixture = createGitFixture({
      'packages/example/src/current-route.ts': 'export const runCurrentRoute = () => 200;\n',
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no changed production legacy candidates');
    expect(result.stdout).toContain('does not prove the absence of production legacy');
  });

  it('does not classify changed governance tooling as a production legacy path', () => {
    const fixture = createGitFixture({
      'scripts/legacy-review.mjs': 'export const legacyReview = () => 200;\n',
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: no changed production legacy candidates');
    expect(result.stdout).not.toContain('scripts/legacy-review.mjs');
  });

  it('skips candidate discovery for a canonical exempt review record', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    writeFileSync(path.join(fixture.root, 'review.json'), JSON.stringify({ scope: 'exempt' }));

    const result = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('explicit PR-review exemption skips legacy candidate scanning');
  });

  it('reports every alias in a multiline export declaration', () => {
    const fixture = createGitFixture({
      'packages/example/src/compatibility-route.ts': [
        'export {',
        '  createCanonicalRoute as createLegacyRoute,',
        '  createCanonicalRoute as createDeprecatedRoute,',
        "} from './canonical-route.ts';",
      ].join('\n'),
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout.match(/compatibility export alias/g)).toHaveLength(2);
  });

  it('checks every reported candidate against final ledger dispositions when a review record is supplied', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    writeFileSync(
      path.join(fixture.root, 'review.json'),
      JSON.stringify({
        finalReview: {
          legacy: {
            candidateCount: 0,
            items: [],
          },
        },
      }),
    );

    const missing = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('FAIL: final review ledger is missing disposition');

    writeReviewRecord(fixture.root, reportedItems(fixture, 'resolved'));

    const complete = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(complete.status, complete.stdout).toBe(0);
    expect(complete.stdout).toContain(
      'PASS: supplied final review ledger disposes every reported candidate',
    );
  });

  it('rejects stale, extra, and duplicate final ledger IDs instead of accepting a subset match', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    const items = reportedItems(fixture, 'resolved');
    writeReviewRecord(
      fixture.root,
      [...items, ledgerItem('production-legacy-candidate-stale', 'resolved'), items[0]],
      1,
    );

    const result = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: final review ledger candidate count must equal items');
    expect(result.stdout).toContain('FAIL: final review ledger has a duplicate candidate ID');
    expect(result.stdout).toContain(
      'FAIL: final review ledger contains an unreported candidate ID',
    );
  });

  it('allows a reviewed false positive only with an explicit not-legacy rationale', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    writeReviewRecord(fixture.root, [
      ...reportedItems(fixture, undefined).map((item) => ({
        ...item,
        classification: 'not-legacy',
        rationale: 'The product name is LegacyRoute; it has no predecessor implementation.',
      })),
    ]);

    const result = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(result.status, result.stdout).toBe(0);
  });

  it('discovers renamed and deleted predecessor paths, non-ASCII paths, and operational support code', () => {
    const fixture = createGitFixture({
      'packages/example/src/old-route.ts': 'export const runRoute = () => 200;\n',
      'packages/example/src/新-legacy-route.ts': 'export const runRoute = () => 200;\n',
      'scripts/deploy/legacy-release.mjs': 'export const deployLegacyRelease = () => 200;\n',
    });

    const result = runLegacyReview(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('packages/example/src/old-route.ts');
    expect(result.stdout).toContain('packages/example/src/新-legacy-route.ts');
    expect(result.stdout).toContain('scripts/deploy/legacy-release.mjs');
  });

  it('fails invalid references with controlled diagnostic output', () => {
    const fixture = createGitFixture({
      'packages/example/src/current-route.ts': 'export const runCurrentRoute = () => 200;\n',
    });

    const result = spawnSync(process.execPath, [reviewLegacyPath, 'not-a-commit', fixture.head], {
      cwd: fixture.root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: base reference does not resolve to a commit');
    expect(result.stderr).not.toContain('Error:');
  });

  it('rejects malformed dispositions and retained legacy that is absent from the durable registry', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    const candidateId = candidateIds(runLegacyReview(fixture).stdout)[0];
    writeFileSync(
      path.join(fixture.root, 'review.json'),
      JSON.stringify({
        finalReview: {
          legacy: {
            candidateCount: 1,
            items: [
              {
                id: candidateId,
                path: 'packages/example/src/legacy-route.ts',
                symbol: 'legacyRoute',
                disposition: 'retained-pending-human-approval',
              },
            ],
          },
        },
      }),
    );
    writeFileSync(
      path.join(fixture.root, 'registry.md'),
      '# Production Legacy Exception Registry\n',
    );

    const result = runLegacyReview(fixture, [
      '--review-record',
      'review.json',
      '--registry',
      'registry.md',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: retained legacy candidate is absent from registry');
    expect(result.stdout).toContain('does not approve retained legacy');
  });

  it('rejects an unknown disposition instead of treating a false-positive claim as an exemption', () => {
    const fixture = createGitFixture({
      'packages/example/src/legacy-route.ts': 'export const legacyRoute = () => 200;\n',
    });
    const candidateId = candidateIds(runLegacyReview(fixture).stdout)[0];
    writeFileSync(
      path.join(fixture.root, 'review.json'),
      JSON.stringify({
        finalReview: {
          legacy: {
            candidateCount: 1,
            items: [
              {
                id: candidateId,
                path: 'packages/example/src/legacy-route.ts',
                symbol: 'legacyRoute',
                disposition: 'false-positive',
              },
            ],
          },
        },
      }),
    );

    const result = runLegacyReview(fixture, ['--review-record', 'review.json']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: final review ledger contains a malformed disposition');
  });
});

function createGitFixture(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-review-fixture-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
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
) {
  return spawnSync(process.execPath, [reviewLegacyPath, fixture.base, fixture.head, ...options], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
}

function candidateLines(output: string): string[] {
  return output.split('\n').filter((line) => line.startsWith('CANDIDATE '));
}

function candidateIds(output: string): string[] {
  return candidateLines(output).map((line) => line.split(' ')[1]);
}

function writeFixture(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeReviewRecord(
  root: string,
  items: readonly {
    readonly id: string;
    readonly path: string;
    readonly symbol: string;
    readonly disposition?: string;
    readonly classification?: string;
    readonly rationale?: string;
  }[],
  candidateCount = items.length,
): void {
  writeFileSync(
    path.join(root, 'review.json'),
    JSON.stringify({ finalReview: { legacy: { candidateCount, items } } }),
  );
}

function reportedItems(
  fixture: { readonly root: string; readonly base: string; readonly head: string },
  disposition: string | undefined,
) {
  return candidateLines(runLegacyReview(fixture).stdout).map((line) => {
    const [id, location, symbol] = line.slice('CANDIDATE '.length).split(' | ');
    const [path, lineNumber] = location.split(':');
    return {
      id,
      path,
      symbol,
      ...(disposition ? { classification: 'legacy', disposition } : {}),
      lineNumber,
    };
  });
}

function ledgerItem(id: string, disposition: string | undefined) {
  return {
    id,
    path: 'packages/example/src/legacy-route.ts',
    symbol: 'legacyRoute',
    ...(disposition ? { classification: 'legacy', disposition } : {}),
  };
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
