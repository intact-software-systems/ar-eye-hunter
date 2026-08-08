import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const base = '8b1ebf542d12c05a5ac226d3d07e543a171a2626';
const manifestPath = 'plans/repo-style-lineages/rallar-group-topology-server-pr-a.json';
const provenancePath = 'plans/repo-style-lineages/rallar-group-topology-server-pr-a-provenance.md';
const expectedLineages = [
  {
    mergeBase: base,
    source: {
      path: 'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts',
      blob: 'c3ff5865c14de0df94f53468f20faacfa2021eda',
    },
    targets: [
      'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts',
    ],
  },
  {
    mergeBase: base,
    source: {
      path: 'packages/shared-server/rallar-system/services/group-topology-config-service.ts',
      blob: 'a78dc11667c80be903b486049ce58a4734334017',
    },
    targets: ['packages/shared-server/rallar-system/topology/config/group-topology-config.ts'],
  },
  {
    mergeBase: base,
    source: {
      path: 'packages/shared-server/rallar-system/services/topology-mutation-authority-proof.ts',
      blob: '2be25a4d4b071c85fd6867842590adf38738e5e6',
    },
    targets: [
      'packages/shared-server/rallar-system/topology/inbox/topology-mutation-authority-proof.ts',
    ],
  },
] as const;
const targetBlobs = new Map([
  [
    'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts',
    'c2928542681065dacfb28968c5ca3bd98f2273b0',
  ],
  [
    'packages/shared-server/rallar-system/topology/config/group-topology-config.ts',
    '45509981e74365c6b011932b067c2bb44abf177f',
  ],
  [
    'packages/shared-server/rallar-system/topology/inbox/topology-mutation-authority-proof.ts',
    '8f95077ffe5abbbbc02a09216f49736a9f175f89',
  ],
] as const);

describe('group topology server PR-A lineage provenance', () => {
  it('binds the exact merge base, source blobs, and target inventory', () => {
    expect(JSON.parse(read(manifestPath))).toEqual({ version: 1, lineages: expectedLineages });
    for (const lineage of expectedLineages) {
      expect(git(['rev-parse', `${base}:${lineage.source.path}`])).toBe(lineage.source.blob);
      for (const target of lineage.targets) expect(existsSync(absolute(target)), target).toBe(true);
    }
  });

  it('records fail-closed symbol, span, magnitude, and source-derivation evidence', () => {
    const provenance = read(provenancePath);

    expect(provenance).toContain(`Base: \`${base}\``);
    for (const lineage of expectedLineages) {
      expect(provenance).toContain(`${lineage.source.path}@${lineage.source.blob}`);
      for (const target of lineage.targets) {
        const targetBlob = targetBlobs.get(target);
        expect(targetBlob, target).toBeDefined();
        expect(git(['hash-object', target]), target).toBe(targetBlob);
        expect(provenance).toContain(`Target: \`${target}\``);
        expect(provenance).toContain(`Target blob: \`${targetBlob}\``);
      }
    }
    for (const field of [
      'Source symbol:',
      'Source span:',
      'Target symbol:',
      'Target span:',
      'Magnitude:',
      'Derivation:',
    ]) {
      expect(provenance).toContain(field);
    }
    expect(provenance).toContain('Semantically new code receives zero historical capacity.');
  });

  it('fails closed when the base, blob, target, or source derivation drifts', () => {
    expect(() => validateLineages({ ...expectedLineages[0], mergeBase: '0'.repeat(40) })).toThrow(
      'base',
    );
    expect(() =>
      validateLineages({
        ...expectedLineages[0],
        source: { ...expectedLineages[0].source, blob: '0'.repeat(40) },
      }),
    ).toThrow('blob');
    expect(() => validateLineages({ ...expectedLineages[0], targets: ['missing.ts'] })).toThrow(
      'target',
    );
    expect(() => validateTargetBlob(expectedLineages[0].targets[0], '0'.repeat(40))).toThrow(
      'target blob',
    );
  });
});

function validateLineages(lineage: {
  readonly mergeBase: string;
  readonly source: Readonly<{ path: string; blob: string }>;
  readonly targets: readonly string[];
}): void {
  if (lineage.mergeBase !== base) throw new Error('base');
  if (git(['rev-parse', `${base}:${lineage.source.path}`]) !== lineage.source.blob) {
    throw new Error('blob');
  }
  for (const target of lineage.targets) {
    if (!existsSync(absolute(target))) throw new Error('target');
  }
}

function validateTargetBlob(target: string, blob: string): void {
  if (targetBlobs.get(target) !== blob || git(['hash-object', target]) !== blob) {
    throw new Error('target blob');
  }
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
