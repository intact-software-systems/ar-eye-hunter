import { describe, expect, it } from 'vitest';

import {
  hashRegions,
  read,
  readBaseBlob,
  readBaseSource,
  readManifest,
  readPrAResultingBlob,
  readPrAResultingTarget,
  readRegions,
  validateEvidence,
} from './client-state-server-lineage-evidence.ts';
import {
  artifactRoot,
  mergeBase,
  persistenceManifestPath,
  prAResultingMain,
  primitivesTarget,
  prBPersistenceLineages,
  semanticEqualityPredicateRegion,
  semanticEqualitySource,
  sourceBlobs,
  targetsBySource,
} from './client-state-server-mutation-lineage-inventory.ts';

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
