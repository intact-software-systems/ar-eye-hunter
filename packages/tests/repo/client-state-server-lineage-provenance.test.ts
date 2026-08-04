import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mergeBase = '39b2b7e6312507addfb4629c9d84ab476e83c362';
const artifactRoot = 'plans/repo-style-lineages/client-state-server-structure';
const sourceBlobs = [
  {
    path: 'packages/shared-server/rallar-system/services/client-state-mutations.ts',
    blob: '9ed11050c1391422202e3cabe5b8798d1a430d0a',
  },
  {
    path: 'packages/shared-server/rallar-system/services/client-state-service.ts',
    blob: 'f135573261f340948c3b846b94230095e137ca25',
  },
  {
    path: 'packages/shared-server/rallar-system/services/client-mutation-authority.ts',
    blob: 'd78b95a44701090f8108167e4e5223436a0a1ad3',
  },
  {
    path: 'packages/shared-server/rallar-system/services/client-expired-state-authority.ts',
    blob: 'd503ffc5e572c7474f7db9cb6cab615ffe62c555',
  },
] as const;

describe('client-state server structural-lineage provenance', () => {
  it('binds mechanically moved command/validation owners to approved source blobs', () => {
    const manifest = JSON.parse(read(`${artifactRoot}.json`));
    expect(manifest).toEqual({
      version: 1,
      lineages: sourceBlobs.map((source) => ({
        mergeBase,
        source,
        targets: targetsBySource[source.path as keyof typeof targetsBySource],
      })),
    });
    for (const source of sourceBlobs) {
      expect(readBaseBlob(source.path), source.path).toBe(source.blob);
    }
    const regions = readRegions();
    for (const region of regions) {
      expect(
        hashRegion(readBaseSource(region.source), region.sourceStart, region.sourceEnd),
        `${region.id} source`,
      ).toBe(region.sourceHash);
      expect(
        hashRegion(read(region.target), region.targetStart, region.targetEnd),
        `${region.id} target`,
      ).toBe(region.targetHash);
      expect(region.findings.length, `${region.id} findings`).toBeGreaterThan(0);
    }
    expect(regions.map((region) => region.owner)).toEqual(
      expect.arrayContaining([
        'client-state-validation-primitives.ts',
        'client-mutation-contracts.ts',
        'client-mutation-command.ts',
        'validate-client-mutation-command.ts',
        'validate-client-mutation-operation-input.ts',
        'validate-client-mutation-request.ts',
      ]),
    );
  });

  it('keeps the prose inventory synchronized with every manifest region', () => {
    const provenance = read(`${artifactRoot}-provenance.md`);
    expect(provenance).toContain(`Merge base: \`${mergeBase}\``);
    for (const region of readRegions(provenance)) {
      expect(provenance, region.id).toContain(`### ${region.id}`);
      expect(provenance, region.target).toContain(`\`${region.target}\``);
      expect(provenance, region.sourceHash).toContain(region.sourceHash);
      expect(provenance, region.targetHash).toContain(region.targetHash);
      expect(region.disposition).toBe('inherited and accepted for PR A');
    }
  });
});

function readBaseBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function readBaseSource(filePath: string): string {
  return execFileSync('git', ['show', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function hashRegion(source: string, start: number, end: number): string {
  const region = source
    .split('\n')
    .slice(start - 1, end)
    .join('\n');
  return createHash('sha256').update(region).digest('hex');
}

function readRegions(provenance = read(`${artifactRoot}-provenance.md`)) {
  const block = provenance.match(/## Machine evidence\n\n```text\n([\s\S]+?)\n```/)?.[1];
  if (!block) throw new Error('Missing client-state machine evidence');
  return block.split('\n').map((line) => {
    const [
      id,
      owner,
      source,
      sourceStart,
      sourceEnd,
      sourceHash,
      target,
      targetStart,
      targetEnd,
      targetHash,
      findings,
      disposition,
    ] = line.split('|');
    return {
      id,
      owner,
      source,
      sourceStart: Number(sourceStart),
      sourceEnd: Number(sourceEnd),
      sourceHash,
      target,
      targetStart: Number(targetStart),
      targetEnd: Number(targetEnd),
      targetHash,
      findings: findings.split(';'),
      disposition,
    };
  });
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

const targetsBySource = {
  'packages/shared-server/rallar-system/services/client-state-mutations.ts': [
    'packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts',
  ],
  'packages/shared-server/rallar-system/services/client-state-service.ts': [
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts',
  ],
  'packages/shared-server/rallar-system/services/client-mutation-authority.ts': [
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts',
  ],
  'packages/shared-server/rallar-system/services/client-expired-state-authority.ts': [
    'packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts',
  ],
} as const;
