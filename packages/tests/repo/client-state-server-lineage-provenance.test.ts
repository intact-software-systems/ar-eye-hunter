import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mergeBase = '39b2b7e6312507addfb4629c9d84ab476e83c362';
const artifactRoot = 'plans/repo-style-lineages/client-state-server-structure';
const mutationsSource = 'packages/shared-server/rallar-system/services/client-state-mutations.ts';
const serviceSource = 'packages/shared-server/rallar-system/services/client-state-service.ts';
const primitivesTarget =
  'packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
const semanticEqualityOwner = {
  path: 'packages/shared-server/rallar-system/services/client-state-semantic-equality.ts',
  blob: 'de169149cb606f9ba9009545a8efd2f50746688c',
  region: '74-77',
} as const;

const sourceBlobs = [
  { path: mutationsSource, blob: '9ed11050c1391422202e3cabe5b8798d1a430d0a' },
  { path: serviceSource, blob: 'f135573261f340948c3b846b94230095e137ca25' },
  {
    path: 'packages/shared-server/rallar-system/services/client-mutation-authority.ts',
    blob: 'd78b95a44701090f8108167e4e5223436a0a1ad3',
  },
  {
    path: 'packages/shared-server/rallar-system/services/client-expired-state-authority.ts',
    blob: 'd503ffc5e572c7474f7db9cb6cab615ffe62c555',
  },
] as const;

const expectedEvidence = [
  evidence(
    'mutation-contracts',
    mutationsSource,
    '46-277',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'import-path and exported-owner glue; no inherited capacity',
    'boundary.unknown:ClientMutationCommand.metadata',
  ),
  evidence(
    'validation-primitives',
    mutationsSource,
    '292-300,2006-2171,2204-2221,2563-2567',
    primitivesTarget,
    'import-path and exported-owner glue; no inherited capacity',
    'function.input-contract:requireAllowedKeys;boundary.unknown:validation-boundary-parameters',
  ),
  evidence(
    'command-root-facts-authority-validation',
    mutationsSource,
    '302-317,2484-2561',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts',
    'private helper declarations; no inherited capacity',
    'boundary.unknown:command-facts-authority-boundaries',
  ),
  evidence(
    'operation-input-validation',
    mutationsSource,
    '318-461,1838-1904,1957-2004,2173-2185,2198-2202',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts',
    'type-only stage contract and helper declarations; no inherited capacity',
    'boundary.unknown:generation-and-timestamp-boundaries',
  ),
  evidence(
    'request-validation',
    mutationsSource,
    '464-610,1905-1907,1935-2004,2173-2175,2187-2196',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts',
    'operation dispatcher and import-path glue; no inherited capacity',
    'boundary.unknown:raw-request-and-timestamp-boundaries',
  ),
  evidence(
    'command-projection-and-hashing',
    serviceSource,
    '310-330,374-582',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts',
    'import-path glue; no inherited capacity',
    'function.input-contract:five-request-projections;function.output-contract:toExpiryCommandInput;function.output-contract:toActorInput',
  ),
  evidence(
    'issued-and-system-authority-projection',
    'packages/shared-server/rallar-system/services/client-mutation-authority.ts',
    '1-37',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts',
    'import-path glue; no inherited capacity',
    'none',
  ),
  evidence(
    'expired-session-authority-validation',
    'packages/shared-server/rallar-system/services/client-expired-state-authority.ts',
    '1-27',
    'packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts',
    'import-path glue; no inherited capacity',
    'boundary.unknown:liveSession',
  ),
] as const;

describe('client-state server structural-lineage provenance', () => {
  it('binds the exact ordered source owners and target inventory', () => {
    expect(readManifest()).toEqual({
      version: 1,
      lineages: sourceBlobs.map((source) => ({
        mergeBase,
        source,
        targets: targetsBySource[source.path as keyof typeof targetsBySource],
      })),
    });
    for (const source of [...sourceBlobs, semanticEqualityOwner]) {
      expect(readBaseBlob(source.path), source.path).toBe(source.blob);
    }
    validateEvidence(readRegions());
  });

  it('keeps the JSON-object predicate in its current semantic-equality owner', () => {
    const primitives = read(primitivesTarget);
    expect(primitives).toContain(
      "import { isClientJsonObject } from '../services/client-state-semantic-equality.ts';",
    );
    expect(primitives).not.toContain('function isJsonObject(');
    expect(
      hashRegions(readBaseSource(semanticEqualityOwner.path), semanticEqualityOwner.region),
    ).toBe('3cb57e0bb4be500115f8a7f051b819b8f18b76cf89de7e0322a8ea041c9570f8');
  });

  it('keeps prose synchronized with the exact evidence and retained owner', () => {
    const provenance = read(`${artifactRoot}-provenance.md`);
    expect(provenance).toContain(`Merge base: \`${mergeBase}\``);
    expect(provenance).toContain(
      `Retained semantic-equality owner: \`${semanticEqualityOwner.path}:74-77\``,
    );
    for (const region of readRegions(provenance)) {
      expect(provenance, region.id).toContain(`### ${region.id}`);
      expect(provenance, region.target).toContain(`\`${region.target}\``);
      expect(region.disposition).toBe('inherited and accepted for PR A');
    }
  });

  it('fails closed for content, ownership, inventory, findings, and semantic additions', () => {
    const regions = readRegions();
    const wrongTarget = structuredClone(regions);
    wrongTarget[0].target = primitivesTarget;
    const broadSourceSpan = structuredClone(regions);
    broadSourceSpan[2].sourceRegions = '302-463,2484-2561';
    const missing = regions.slice(1);
    const duplicate = [...regions, regions[0]];
    const reordered = [...regions].reverse();
    const wrongFinding = structuredClone(regions);
    wrongFinding[0].findings = ['file.length:wrong-owner'];
    const semanticAddition = new Map([
      [regions[0].target, `${read(regions[0].target)}\nexport const semanticAddition = true;\n`],
    ]);
    const changedContent = new Map([
      [regions[1].target, read(regions[1].target).replace('must be a string', 'must be text')],
    ]);

    for (const [fixture, message] of [
      [wrongTarget, 'exact evidence inventory'],
      [broadSourceSpan, 'exact evidence inventory'],
      [missing, 'exact evidence inventory'],
      [duplicate, 'exact evidence inventory'],
      [reordered, 'exact evidence inventory'],
      [wrongFinding, 'exact evidence inventory'],
    ] as const) {
      expect(() => validateEvidence(fixture), message).toThrow(message);
    }
    expect(() => validateEvidence(regions, semanticAddition)).toThrow(/target (?:hash|region)/);
    expect(() => validateEvidence(regions, changedContent)).toThrow('target hash');
  });
});

function validateEvidence(
  regions: readonly EvidenceRegion[],
  targetOverrides = new Map<string, string>(),
): void {
  if (JSON.stringify(regions.map(toEvidenceIdentity)) !== JSON.stringify(expectedEvidence)) {
    throw new Error('exact evidence inventory');
  }
  for (const region of regions) {
    if (hashRegions(readBaseSource(region.source), region.sourceRegions) !== region.sourceHash) {
      throw new Error(`source hash ${region.id}`);
    }
    const target = targetOverrides.get(region.target) ?? read(region.target);
    if (hashRegions(target, `${region.targetStart}-${region.targetEnd}`) !== region.targetHash) {
      throw new Error(`target hash ${region.id}`);
    }
    const targetLines = target.split('\n').length - (target.endsWith('\n') ? 1 : 0);
    if (region.targetStart !== 1 || region.targetEnd !== targetLines) {
      throw new Error(`target region ${region.id}`);
    }
    if (region.findings.includes('file.length')) {
      throw new Error(`wrong finding ownership ${region.id}`);
    }
  }
}

function evidence(
  id: string,
  source: string,
  sourceRegions: string,
  target: string,
  exclusions: string,
  findings: string,
) {
  return {
    id,
    source,
    sourceRegions,
    target,
    exclusions,
    findings: findings.split(';'),
    disposition: 'inherited and accepted for PR A',
  };
}

function toEvidenceIdentity(region: EvidenceRegion) {
  return {
    id: region.id,
    source: region.source,
    sourceRegions: region.sourceRegions,
    target: region.target,
    exclusions: region.exclusions,
    findings: region.findings,
    disposition: region.disposition,
  };
}

function readRegions(provenance = read(`${artifactRoot}-provenance.md`)): EvidenceRegion[] {
  const block = provenance.match(/## Machine evidence\n\n```text\n([\s\S]+?)\n```/)?.[1];
  if (!block) throw new Error('Missing client-state machine evidence');
  return block.split('\n').map((line) => {
    const [
      id,
      source,
      sourceRegions,
      sourceHash,
      target,
      targetStart,
      targetEnd,
      targetHash,
      exclusions,
      findings,
      disposition,
    ] = line.split('|');
    return {
      id,
      source,
      sourceRegions,
      sourceHash,
      target,
      targetStart: Number(targetStart),
      targetEnd: Number(targetEnd),
      targetHash,
      exclusions,
      findings: findings.split(';'),
      disposition,
    };
  });
}

function readManifest(): unknown {
  return JSON.parse(read(`${artifactRoot}.json`));
}

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

function hashRegions(source: string, regions: string): string {
  const lines = source.split('\n');
  const selected = regions.split(',').map((region) => {
    const [start, end] = region.split('-').map(Number);
    if (!start || !end || start > end) throw new Error(`invalid region ${region}`);
    return lines.slice(start - 1, end).join('\n');
  });
  return createHash('sha256').update(selected.join('\n--- region ---\n')).digest('hex');
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

interface EvidenceRegion {
  id: string;
  source: string;
  sourceRegions: string;
  sourceHash: string;
  target: string;
  targetStart: number;
  targetEnd: number;
  targetHash: string;
  exclusions: string;
  findings: string[];
  disposition: string;
}

const targetsBySource = {
  [mutationsSource]: [
    'packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts',
  ],
  [serviceSource]: [
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts',
  ],
  'packages/shared-server/rallar-system/services/client-mutation-authority.ts': [
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts',
  ],
  'packages/shared-server/rallar-system/services/client-expired-state-authority.ts': [
    'packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts',
  ],
} as const;
