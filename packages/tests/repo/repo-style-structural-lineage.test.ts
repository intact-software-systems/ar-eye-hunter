import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupStructuralLineageFixtures,
  commitAll,
  createSplitFixture,
  lineage,
  overParameterizedSource,
  readBlob,
  runChangedChecker,
  runGit,
  type SplitFixture,
  unknownSource,
  writeBoundarySummaryVariantLoader,
  writeFixture,
  writeLineageManifest,
  writeLineageManifestAt,
} from './repo-style-structural-lineage-fixtures.ts';

afterEach(() => {
  cleanupStructuralLineageFixtures();
});

describe('changed repository style structural lineage', () => {
  it('fails without aggregate lineage when one owner splits into multiple targets', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha'), overParameterizedSource('bravo')],
      targetFindings: [[overParameterizedSource('gamma')], [overParameterizedSource('delta')]],
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: 2 new or worsened repository style findings');
  });

  it('aggregates mapped split targets before consuming base findings', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha'), overParameterizedSource('bravo')],
      targetFindings: [[overParameterizedSource('gamma')], [overParameterizedSource('delta')]],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('ignores an untracked manifest when explicit HEAD owns policy', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha')],
      targetFindings: [[overParameterizedSource('bravo')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture)]);

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('apps/example/target-a.ts [function.input-contract]');
  });

  it('loads an untracked manifest when WORKTREE owns policy and sources', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha')],
      targetFindings: [[overParameterizedSource('bravo')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture)]);

    const result = runChangedChecker({
      root: fixture.root,
      mergeBase: fixture.mergeBase,
      targetReference: 'WORKTREE',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('loads a committed manifest when explicit HEAD owns policy and sources', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha')],
      targetFindings: [[overParameterizedSource('bravo')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture)]);
    commitAll(fixture.root, 'add structural lineage policy');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('discovers nested manifests equivalently in WORKTREE and explicit HEAD', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha')],
      targetFindings: [[overParameterizedSource('bravo')]],
    });
    writeLineageManifestAt(fixture.root, 'plans/repo-style-lineages/nested/example.json', [lineage(fixture)]);

    const worktreeResult = runChangedChecker({
      root: fixture.root,
      mergeBase: fixture.mergeBase,
      targetReference: 'WORKTREE',
    });
    expect(worktreeResult.status).toBe(0);
    expect(worktreeResult.stdout).toContain('PASS: no new repository style findings');

    commitAll(fixture.root, 'commit nested structural lineage policy');
    const headResult = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });
    expect(headResult.status).toBe(0);
    expect(headResult.stdout).toContain('PASS: no new repository style findings');
  });

  it('compares boundary unknown occurrence capacity across a split aggregate', () => {
    const fixture = createSplitFixture({
      baseFindings: [unknownSource('base', 12)],
      targetFindings: [[unknownSource('alpha', 6)], [unknownSource('bravo', 6)]],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('keeps aggregate boundary unknown occurrence growth as worsened', () => {
    const fixture = createSplitFixture({
      baseFindings: [unknownSource('base', 12)],
      targetFindings: [[unknownSource('alpha', 6)], [unknownSource('bravo', 7)]],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('apps/example/target-b.ts [boundary.unknown]');
    expect(result.stdout).toContain('... and 2 additional unknown occurrences');
  });

  it('counts only the exact boundary unknown summary message as aggregate capacity', () => {
    const fixture = createSplitFixture({
      baseFindings: [],
      targetFindings: [[]],
      manifest: true,
    });
    const loaderPath = writeBoundarySummaryVariantLoader(fixture.root);

    const result = runChangedChecker({
      root: fixture.root,
      mergeBase: fixture.mergeBase,
      targetReference: 'WORKTREE',
      nodeArguments: ['--experimental-loader', loaderPath],
    });

    expect(result.stderr).not.toContain('ERR_');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('consumes a base finding only once when a split target duplicates it', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('next')], [overParameterizedSource('more')]],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
    expect(result.stdout).toContain('apps/example/target-b.ts [function.input-contract]');
  });

  it('keeps a larger mapped target magnitude as worsened', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('target', 30)]],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('has 34 parameters');
  });

  it('keeps an unmapped target finding new', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('mapped')]],
      manifest: true,
    });
    writeFixture(fixture.root, 'apps/example/unmapped.ts', overParameterizedSource('unmapped'));
    commitAll(fixture.root, 'add unmapped target');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/example/unmapped.ts [function.input-contract]');
  });

  it('keeps layout findings on a mapped target path', () => {
    const fixture = createSplitFixture({
      baseFindings: [],
      targetFindings: [[]],
      targetPaths: ['apps/example/BadTarget.ts'],
      manifest: true,
    });

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[layout.filename-style]');
  });

  it('does not load a lineage for a stale merge base', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('next')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture, { mergeBase: '0'.repeat(40) })]);
    commitAll(fixture.root, 'add stale lineage');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/example/target-a.ts [function.input-contract]');
  });

  it.each([
    {
      name: 'wrong source blob',
      mutate: (fixture: SplitFixture) => lineage(fixture, { sourceBlob: '0'.repeat(40) }),
      diagnostic: 'source blob does not match',
    },
    {
      name: 'missing source',
      mutate: (fixture: SplitFixture) =>
        lineage(fixture, {
          sourcePath: 'apps/example/missing-source.ts',
          sourceBlob: '0'.repeat(40),
        }),
      diagnostic: 'source does not exist at merge base',
    },
    {
      name: 'missing target',
      mutate: (fixture: SplitFixture) => lineage(fixture, { targets: ['apps/example/missing-target.ts'] }),
      diagnostic: 'target does not exist',
    },
    {
      name: 'duplicate target',
      mutate: (fixture: SplitFixture) =>
        lineage(fixture, {
          targets: ['apps/example/target-a.ts', 'apps/example/target-a.ts'],
        }),
      diagnostic: 'duplicate target',
    },
    {
      name: 'malformed path',
      mutate: (fixture: SplitFixture) => lineage(fixture, { targets: ['apps/example/../outside.ts'] }),
      diagnostic: 'target path must be a normalized repository-relative path',
    },
    {
      name: 'non-production path',
      mutate: (fixture: SplitFixture) => lineage(fixture, { targets: ['packages/tests/example.ts'] }),
      diagnostic: 'target path must name production code',
    },
  ])('fails closed for a $name', ({ mutate, diagnostic }) => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('target')]],
    });
    writeLineageManifest(fixture.root, [mutate(fixture)]);
    commitAll(fixture.root, 'add invalid lineage');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(diagnostic);
  });

  it('fails closed when one target belongs to conflicting lineages', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('target')]],
    });
    writeFixture(fixture.root, 'apps/example/other-owner.ts', overParameterizedSource('other'));
    commitAll(fixture.root, 'add other base owner');
    const otherBlob = readBlob(fixture.root, 'HEAD', 'apps/example/other-owner.ts');
    writeLineageManifest(fixture.root, [
      lineage(fixture),
      {
        mergeBase: fixture.mergeBase,
        source: { path: 'apps/example/other-owner.ts', blob: otherBlob },
        targets: ['apps/example/target-a.ts'],
      },
    ]);
    commitAll(fixture.root, 'add conflicting lineages');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('target belongs to multiple lineages');
  });

  it('fails closed when one source has conflicting lineage entries', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha'), overParameterizedSource('bravo')],
      targetFindings: [[overParameterizedSource('gamma')], [overParameterizedSource('delta')]],
    });
    writeLineageManifest(fixture.root, [
      lineage(fixture, { targets: [fixture.targetPaths[0]] }),
      lineage(fixture, { targets: [fixture.targetPaths[1]] }),
    ]);
    commitAll(fixture.root, 'add conflicting source lineages');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('source has multiple lineage entries');
  });

  it('accepts a one-to-one move when Git rename detection loses identity', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('next')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture)]);
    runGit(fixture.root, ['rm', fixture.sourcePath]);
    commitAll(fixture.root, 'remove compatibility owner');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('authenticates split findings after the obsolete source owner is removed', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('alpha'), overParameterizedSource('bravo')],
      targetFindings: [[overParameterizedSource('gamma')], [overParameterizedSource('delta')]],
    });
    writeLineageManifest(fixture.root, [lineage(fixture)]);
    runGit(fixture.root, ['rm', fixture.sourcePath]);
    commitAll(fixture.root, 'remove compatibility owner');

    const result = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no new repository style findings');
  });

  it('reports malformed manifests and manifest traversal deterministically', () => {
    const fixture = createSplitFixture({
      baseFindings: [overParameterizedSource('base')],
      targetFindings: [[overParameterizedSource('target')]],
    });
    writeFixture(fixture.root, 'plans/repo-style-lineages/zeta.json', '{"version":1,"lineages":"not-an-array"}\n');
    writeFixture(fixture.root, 'plans/repo-style-lineages/alpha.json', '{"version":2,"lineages":[]}\n');
    commitAll(fixture.root, 'add malformed manifests');

    const first = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });
    const second = runChangedChecker({ root: fixture.root, mergeBase: fixture.mergeBase });

    expect(first.status).toBe(2);
    expect(first.stderr).toBe(second.stderr);
    expect(first.stderr).toBe(
      [
        'Invalid repository style structural lineage manifest:',
        '- plans/repo-style-lineages/alpha.json: version must equal 1',
        '- plans/repo-style-lineages/zeta.json: lineages must be an array',
        '',
      ].join('\n'),
    );
  });
});
