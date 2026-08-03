import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const manifestPath = 'plans/repo-style-lineages/api-v1-group-state-route-structure.json';
const provenancePath = 'plans/repo-style-lineages/api-v1-group-state-route-structure-provenance.md';
const mergeBase = '0a52ecee39181c7784fa6b777270f8a59bc33c00';

const expectedLineages = [
  {
    mergeBase,
    source: {
      path: 'apps/api-v1/src/routes/group-state-routes.ts',
      blob: 'aced85e681666edde414be27b68278ddff53fc42',
    },
    targets: [
      'apps/api-v1/src/group-state/read-group-state-route-request.ts',
      'apps/api-v1/src/group-state/register-group-presence-routes.ts',
    ],
  },
  {
    mergeBase,
    source: {
      path: 'apps/api-v1/src/routes/group-state-route-errors.ts',
      blob: 'cd58fb90d1836c33be35f417a6a04376150a2327',
    },
    targets: ['apps/api-v1/src/group-state/group-state-route-errors.ts'],
  },
] as const;

const prohibitedTargets = [
  'apps/api-v1/src/group-state/to-group-state-command.ts',
  'apps/api-v1/src/group-state/group-state-route-contracts.ts',
  'apps/api-v1/src/create-rallar-server.ts',
  'packages/tests/repo/group-state-navigation-map-integrity.test.ts',
  'packages/tests/shared-server/mutation-route-owner-analysis.test.ts',
] as const;

const inheritedFindingDispositions = [
  'boundary.unknown at request JSON boundary (line 5)',
  'route.handler-length at callback line 47',
  'route.handler-length at callback line 92',
  'route.handler-length at callback line 137',
  'boundary.unknown at line 35',
  'boundary.unknown at line 37',
  'boundary.unknown at line 63',
  'boundary.unknown at line 81',
  'boundary.unknown at line 106',
  'boundary.unknown at line 134',
] as const;

const expectedProvenance = [
  {
    sourcePath: 'apps/api-v1/src/routes/group-state-routes.ts',
    sourceBlob: 'aced85e681666edde414be27b68278ddff53fc42',
    sourceSpan:
      'readRequestWithRequestId<T> (lines 1036-1051); presence route callbacks (lines 778-913)',
    targets: [
      {
        targetPath: 'apps/api-v1/src/group-state/read-group-state-route-request.ts',
        targetSpan: 'GroupStateRouteRequestContext and readGroupStateRouteRequest<T> (lines 3-20)',
        disposition:
          'boundary.unknown at request JSON boundary (line 5): inherited and accepted for PR A; Task 7 owns any alignment.',
      },
      {
        targetPath: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
        targetSpan: 'connect, heartbeat, and disconnect route callbacks (lines 47-171)',
        disposition:
          'route.handler-length at callback lines 47, 92, and 137: inherited and accepted for PR A; Task 7 owns any alignment.',
      },
    ],
  },
  {
    sourcePath: 'apps/api-v1/src/routes/group-state-route-errors.ts',
    sourceBlob: 'cd58fb90d1836c33be35f417a6a04376150a2327',
    sourceSpan: 'entire module (lines 1-136)',
    targets: [
      {
        targetPath: 'apps/api-v1/src/group-state/group-state-route-errors.ts',
        targetSpan: 'entire module (lines 1-136)',
        disposition:
          'boundary.unknown at lines 35, 37, 63, 81, 106, and 134: inherited and accepted for PR A; Task 7 owns any alignment.',
      },
    ],
  },
] as const;

describe('API-v1 group-state route structural-lineage provenance', () => {
  it('keeps the exact authorized merge-base lineage inventory and source blobs', () => {
    const manifest = readJson(manifestPath);

    validateManifest(manifest, expectedLineages);
    for (const lineage of expectedLineages) {
      expect(readBlob(lineage.source.path)).toBe(lineage.source.blob);
      for (const targetPath of lineage.targets) {
        expect(existsSync(path.join(repoRoot, targetPath)), `${targetPath} must exist`).toBe(true);
      }
    }
  });

  it('does not grant inherited capacity to semantically new route structure', () => {
    const manifest = readJson(manifestPath);
    const targetPaths = validateManifest(manifest, expectedLineages).flatMap(
      (lineage) => lineage.targets,
    );

    expect(targetPaths).not.toEqual(expect.arrayContaining([...prohibitedTargets]));
    expect(existsSync(path.join(repoRoot, 'apps/api-v1/src/routes/group-state-routes.ts'))).toBe(
      true,
    );
    expect(
      existsSync(path.join(repoRoot, 'apps/api-v1/src/routes/group-state-route-errors.ts')),
    ).toBe(true);
  });

  it('binds every inherited finding to its predecessor and target source span', () => {
    expect(existsSync(path.join(repoRoot, provenancePath)), `${provenancePath} must exist`).toBe(
      true,
    );
    if (!existsSync(path.join(repoRoot, provenancePath))) return;

    validateProvenance(
      readFileSync(path.join(repoRoot, provenancePath), 'utf8'),
      expectedProvenance,
    );
    const provenance = readFileSync(path.join(repoRoot, provenancePath), 'utf8');
    for (const findingDisposition of inheritedFindingDispositions) {
      expect(provenance).toContain(findingDisposition);
    }
  });

  it('fails closed for missing, additional, reordered, duplicated, or changed lineage data', () => {
    const additional = toMutableManifest();
    additional.lineages.push(toMutableLineage(expectedLineages[0]));

    const missing = toMutableManifest();
    missing.lineages.pop();

    const reordered = toMutableManifest();
    reordered.lineages.reverse();

    const duplicated = toMutableManifest();
    duplicated.lineages[0].targets.push(duplicated.lineages[0].targets[0]);

    const changedBlob = toMutableManifest();
    changedBlob.lineages[0].source.blob = '0'.repeat(40);

    expect(() => validateManifest(additional, expectedLineages)).toThrow('lineage count');
    expect(() => validateManifest(missing, expectedLineages)).toThrow('lineage count');
    expect(() => validateManifest(reordered, expectedLineages)).toThrow('lineage 0');
    expect(() => validateManifest(duplicated, expectedLineages)).toThrow('target count');
    expect(() => validateManifest(changedBlob, expectedLineages)).toThrow('source blob');
  });
});

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, filePath), 'utf8'));
}

function readBlob(sourcePath: string): string {
  return execFileSync('git', ['rev-parse', `${mergeBase}:${sourcePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function validateManifest(
  value: unknown,
  expected: readonly (typeof expectedLineages)[number][],
): readonly (typeof expectedLineages)[number][] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.lineages)) {
    throw new Error('manifest must contain version 1 and a lineage array');
  }
  if (value.lineages.length !== expected.length) throw new Error('wrong lineage count');

  return value.lineages.map((lineage, index) => {
    const expectedLineage = expected[index];
    if (!isRecord(lineage) || expectedLineage === undefined) {
      throw new Error(`invalid lineage ${index}`);
    }
    if (lineage.mergeBase !== expectedLineage.mergeBase)
      throw new Error(`lineage ${index} merge base`);
    if (!isRecord(lineage.source)) throw new Error(`lineage ${index} source`);
    if (lineage.source.path !== expectedLineage.source.path) {
      throw new Error(`lineage ${index} source path`);
    }
    if (lineage.source.blob !== expectedLineage.source.blob) {
      throw new Error(`lineage ${index} source blob`);
    }
    if (
      !Array.isArray(lineage.targets) ||
      lineage.targets.length !== expectedLineage.targets.length
    ) {
      throw new Error(`lineage ${index} target count`);
    }
    if (new Set(lineage.targets).size !== lineage.targets.length) {
      throw new Error(`lineage ${index} duplicate target`);
    }
    for (const [targetIndex, targetPath] of lineage.targets.entries()) {
      if (targetPath !== expectedLineage.targets[targetIndex]) {
        throw new Error(`lineage ${index} target ${targetIndex}`);
      }
    }
    return expectedLineage;
  });
}

function validateProvenance(
  provenance: string,
  expected: readonly (typeof expectedProvenance)[number][],
): void {
  const sourceSections = [...provenance.matchAll(/^## Source: `([^`]+)`\s*$/gm)];
  expect(sourceSections).toHaveLength(expected.length);

  for (const [sourceIndex, expectedSource] of expected.entries()) {
    const sourceMatch = sourceSections[sourceIndex];
    expect(sourceMatch?.[1]).toBe(expectedSource.sourcePath);
    const sourceBody = provenance.slice(sourceMatch?.index, sourceSections[sourceIndex + 1]?.index);
    expect(sourceBody).toContain(`Source blob: \`${expectedSource.sourceBlob}\``);
    expect(sourceBody).toContain(`Source symbol or line span: \`${expectedSource.sourceSpan}\``);
    expect(sourceBody).toContain('Source changed regions: `mechanically moved regions only`');

    const targetSections = [...sourceBody.matchAll(/^### Target: `([^`]+)`\s*$/gm)];
    expect(targetSections).toHaveLength(expectedSource.targets.length);
    for (const [targetIndex, expectedTarget] of expectedSource.targets.entries()) {
      const targetMatch = targetSections[targetIndex];
      expect(targetMatch?.[1]).toBe(expectedTarget.targetPath);
      const targetBody = sourceBody.slice(
        targetMatch?.index,
        targetSections[targetIndex + 1]?.index,
      );
      expect(targetBody).toContain(`Target symbol or line span: \`${expectedTarget.targetSpan}\``);
      expect(targetBody).toContain('Target changed regions: `mechanically moved regions only`');
      expect(targetBody).toContain('Mechanical-move classification: `mechanical move`');
      expect(targetBody).toContain(
        'Semantic additions excluded from inherited capacity: `all other target contents`',
      );
      expect(targetBody).toContain(`Human disposition: \`${expectedTarget.disposition}\``);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface MutableManifest {
  readonly version: number;
  readonly lineages: MutableLineage[];
}

interface MutableLineage {
  readonly mergeBase: string;
  readonly source: MutableSource;
  readonly targets: string[];
}

interface MutableSource {
  readonly path: string;
  blob: string;
}

function toMutableManifest(): MutableManifest {
  return {
    version: 1,
    lineages: expectedLineages.map(toMutableLineage),
  };
}

function toMutableLineage(lineage: (typeof expectedLineages)[number]): MutableLineage {
  return {
    mergeBase: lineage.mergeBase,
    source: { ...lineage.source },
    targets: [...lineage.targets],
  };
}
