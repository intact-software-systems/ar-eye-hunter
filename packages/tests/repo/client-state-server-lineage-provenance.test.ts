import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mergeBase = '39b2b7e6312507addfb4629c9d84ab476e83c362';
const prAResultingMain = '2fdba024bb347622727d337eb06fc13d2fe129fc';
const artifactRoot = 'plans/repo-style-lineages/client-state-server-structure';
const persistenceManifestPath = 'plans/repo-style-lineages/client-state-server-persistence.json';
const mutationsSource = 'packages/shared-server/rallar-system/services/client-state-mutations.ts';
const serviceSource = 'packages/shared-server/rallar-system/services/client-state-service.ts';
const primitivesTarget =
  'packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
const semanticEqualitySource = {
  path: 'packages/shared-server/rallar-system/services/client-state-semantic-equality.ts',
  blob: 'de169149cb606f9ba9009545a8efd2f50746688c',
} as const;
const semanticEqualityPredicateRegion = '74-77';

const sourceBlobs = [
  { path: mutationsSource, blob: '9ed11050c1391422202e3cabe5b8798d1a430d0a' },
  semanticEqualitySource,
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

const prBPersistenceLineages = [
  [
    'packages/shared-server/rallar-system/client-presence-state.ts',
    '60b0ecdd48e29ba4bbd3735e48ec3ad9a0741a27',
    ['packages/shared-server/rallar-system/client-state/client-presence-state.ts'],
  ],
  [
    'packages/shared-server/rallar-system/client-state-storage-keys.ts',
    '677e87f18f06c450b4b412e1ae438ea5b9d850c3',
    ['packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts'],
  ],
  [
    'packages/shared-server/rallar-system/repositories/ClientStateRepository.ts',
    '9681469561f33b48cd5320dc7ad013c715c19ebe',
    [
      'packages/shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts',
      'packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts',
      'packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts',
      'packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts',
      'packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/services/client-state-mutations.ts',
    'e4c8219a22ba6e3d47e3b139d44546b1fda436f0',
    [
      'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts',
      'packages/shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts',
    ],
  ],
  [
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'b5e091fe588f88fa63eadf1d4c24d7c04aa3df00',
    [
      'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts',
    ],
  ],
] as const;

const expectedEvidence = [
  evidence(
    'mutation-contracts',
    mutationsSource,
    '46-277,1838-1861',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'import-path, export modifiers, and contract-owner formatting; no inherited capacity',
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
    'direct lower-contract imports and private helper declarations; no inherited capacity',
    'boundary.unknown:command-facts-authority-boundaries',
  ),
  evidence(
    'operation-input-validation',
    mutationsSource,
    '318-461,1862-1904,1957-2004,2173-2185,2198-2202',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts',
    'direct compatibility exports, type-only stage contract, and helper declarations; no inherited capacity',
    'boundary.unknown:generation-and-timestamp-boundaries',
  ),
  evidence(
    'request-validation',
    mutationsSource,
    '464-610,1905-1907,1935-2004,2173-2175,2187-2196',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts',
    'operation dispatcher and direct lower-contract imports; no inherited capacity',
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
  evidence(
    'contract-validation',
    mutationsSource,
    '2286-2298,2300-2352,2354-2387,2389-2456,2458-2470,2615-2641,2643-2665',
    'packages/shared-server/rallar-system/client-state/client-state-contract-validation.ts',
    'export modifiers, shared lower-level naming, direct contract-owner imports, and helper splits; no inherited capacity',
    'boundary.unknown:client-contract-validation-boundaries',
  ),
  evidence(
    'receipt-validation',
    mutationsSource,
    '2569-2613,2673-2687',
    'packages/shared-server/rallar-system/client-state/client-mutation-receipt-validation.ts',
    'export modifiers and receipt helper splits; no inherited capacity',
    'boundary.unknown:receipt-idempotency-validation-boundaries',
  ),
  evidence(
    'compute-dispatcher',
    mutationsSource,
    '829-869',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts',
    'direct family imports and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-principal',
    mutationsSource,
    '1114-1126,1560-1604',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts',
    'direct shared-owner imports and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-instance',
    mutationsSource,
    '1128-1160,1634-1654',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts',
    'direct shared-owner imports and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-connect',
    mutationsSource,
    '1162-1227,1656-1713',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts',
    'named generation tuple input and direct shared-owner imports; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-heartbeat',
    mutationsSource,
    '1229-1265',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts',
    'direct shared-owner imports and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-disconnect',
    mutationsSource,
    '1267-1311',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts',
    'direct shared-owner imports and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-expiry',
    mutationsSource,
    '1313-1345',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts',
    'current-session predicate extraction and named-input syntax; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-result',
    mutationsSource,
    '1347-1558,1738-1760',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-result.ts',
    'named inputs and cohesive result-construction helpers; no inherited capacity',
    'none',
  ),
  evidence(
    'compute-state',
    mutationsSource,
    '1606-1632,1715-1736,1762-1827',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-state.ts',
    'named inputs and cohesive state-construction helpers; no inherited capacity',
    'none',
  ),
  evidence(
    'validate-read',
    mutationsSource,
    '980-1050,2472-2482',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts',
    'scope helper splits and direct lower-level validators; no inherited capacity',
    'boundary.unknown:stable-read-boundaries',
  ),
  evidence(
    'validate-authority',
    mutationsSource,
    '1052-1112',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts',
    'issued/system helper split; no inherited capacity',
    'none',
  ),
  evidence(
    'validate-result',
    mutationsSource,
    '2689-2822',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts',
    'outcome helper splits and direct lower-level validators; no inherited capacity',
    'boundary.unknown:computed-result-boundaries',
  ),
  evidence(
    'validate-mutation',
    mutationsSource,
    '278-290,871-978',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts',
    'named-input syntax and invariant helper splits; no inherited capacity',
    'none',
  ),
  evidence(
    'semantic-equality',
    semanticEqualitySource.path,
    '1-78',
    'packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts',
    'canonical import path and formatting; no inherited capacity',
    'boundary.unknown:json-semantic-equality',
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
    for (const source of sourceBlobs) {
      expect(readBaseBlob(source.path), source.path).toBe(source.blob);
    }
    validateEvidence(readRegions());
  });

  it('keeps the JSON-object predicate in its canonical semantic-equality owner', () => {
    const primitives = read(primitivesTarget);
    expect(primitives).toContain(
      "import { isClientJsonObject } from './client-state-semantic-equality.ts';",
    );
    expect(primitives).not.toContain('function isJsonObject(');
    expect(
      hashRegions(readBaseSource(semanticEqualitySource.path), semanticEqualityPredicateRegion),
    ).toBe('3cb57e0bb4be500115f8a7f051b819b8f18b76cf89de7e0322a8ea041c9570f8');
  });

  it('keeps prose synchronized with the exact evidence and canonical owner', () => {
    const provenance = read(`${artifactRoot}-provenance.md`);
    expect(provenance).toContain(`Merge base: \`${mergeBase}\``);
    expect(provenance).toContain(
      'Canonical semantic-equality owner: `packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts`',
    );
    for (const region of readRegions(provenance)) {
      expect(provenance, region.id).toContain(`### ${region.id}`);
      expect(provenance, region.target).toContain(`\`${region.target}\``);
      expect(region.disposition).toBe('inherited and accepted for PR A');
    }
  });

  it('records the exact PR B persistence predecessor blobs and owners', () => {
    const provenance = read(`${artifactRoot}-provenance.md`);
    expect(JSON.parse(read(persistenceManifestPath))).toEqual({
      version: 1,
      lineages: prBPersistenceLineages.map(([path, blob, targets]) => ({
        mergeBase: prAResultingMain,
        source: { path, blob },
        targets,
      })),
    });
    for (const [sourcePath, sourceBlob] of prBPersistenceLineages) {
      expect(readPrAResultingBlob(sourcePath), sourcePath).toBe(sourceBlob);
      expect(provenance, sourcePath).toContain(`${sourcePath}@${sourceBlob}`);
    }
    expect(provenance).toContain('## PR B persistence source evidence');
    expect(provenance).toContain(
      '`packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts`',
    );
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
      [
        regions[0].target,
        `${readPrAResultingTarget(regions[0].target)}\nexport const semanticAddition = true;\n`,
      ],
    ]);
    const changedContent = new Map([
      [
        regions[1].target,
        readPrAResultingTarget(regions[1].target).replace('must be a string', 'must be text'),
      ],
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
    const target = targetOverrides.get(region.target) ?? readPrAResultingTarget(region.target);
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

function readPrAResultingTarget(filePath: string): string {
  return execFileSync('git', ['show', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function readPrAResultingBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
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
    'packages/shared-server/rallar-system/client-state/client-state-contract-validation.ts',
    'packages/shared-server/rallar-system/client-state/client-mutation-receipt-validation.ts',
    'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts',
    'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-result.ts',
    'packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-state.ts',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts',
    'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts',
  ],
  [semanticEqualitySource.path]: [
    'packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts',
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
