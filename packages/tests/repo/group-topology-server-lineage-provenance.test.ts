import { describe, expect, it } from 'vitest';

import {
  base,
  createEvidenceWithDuplicatedBoundaryRow,
  createEvidenceWithoutBoundaryRow,
  createDriftedEvidence,
  evidence,
  evidenceLeafPaths,
  evidenceSource,
  expectedEvidenceHash,
  manifest,
  mutationBoundaryOwner,
  mutationReceiptValidator,
  mutationRecordValidator,
  mutationSource,
  read,
  sha256,
  unknownBoundaryLineCount,
  unknownBoundaryOwners,
  validateBoundaryBijection,
  validateEvidence,
} from './group-topology-server-lineage-provenance-fixtures.ts';
import { expectedBoundaryOwners } from './group-topology-server-lineage-boundary-bijection.ts';

describe('group topology server PR-A lineage provenance', () => {
  it('maps the deleted mutation source to its genuine canonical boundary owner', () => {
    const lineage = manifest.lineages.find((candidate) => candidate.source.path === mutationSource);

    expect(lineage).toEqual({
      mergeBase: base,
      source: {
        path: mutationSource,
        blob: 'c3ff5865c14de0df94f53468f20faacfa2021eda',
      },
      targets: [mutationBoundaryOwner],
    });
    const boundarySource = read(mutationBoundaryOwner);
    expect(unknownBoundaryLineCount(boundarySource)).toBe(14);
    expect(unknownBoundaryOwners(boundarySource).toSorted()).toEqual(
      [...expectedBoundaryOwners].toSorted(),
    );
    for (const target of [mutationRecordValidator, mutationReceiptValidator]) {
      expect(unknownBoundaryLineCount(read(target)), target).toBe(0);
      expect(read(target), target).not.toContain('TopologyConfigBoundaryValue');
    }
  });

  it('pins the complete structured evidence document', () => {
    expect(sha256(evidenceSource)).toBe(expectedEvidenceHash);
    expect(evidence.version).toBe(1);
    expect(evidence.rows.map(({ id }) => id)).toEqual([
      'mutation-module-extraction',
      'config-resolution-relocation',
      'authority-proof-relocation',
      'generation-boundary',
      'invariant-generation-boundary',
      'stored-config-boundary',
      'stored-override-boundary',
      'mutation-record-boundary',
      'receipt-boundary',
      'accepted-config-boundary',
      'group-ref-boundary',
      'causal-revision-boundary',
      'exact-keys-boundary',
      'positive-integer-boundary',
      'storage-revision-boundary',
      'required-string-boundary',
      'record-boundary',
    ]);
  });

  it('verifies every base/blob/path/symbol/span/hash/magnitude/derivation field', () => {
    validateEvidence(evidence, evidence);
  });

  it('keeps the lineage test and its cohesive fixture owner below 400 lines', () => {
    for (const ownerPath of [
      'packages/tests/repo/group-topology-server-lineage-boundary-bijection.ts',
      'packages/tests/repo/group-topology-server-lineage-provenance-fixtures.ts',
      'packages/tests/repo/group-topology-server-lineage-provenance.test.ts',
    ]) {
      expect(read(ownerPath).split('\n').length, ownerPath).toBeLessThanOrEqual(401);
    }
  });

  it('rejects deleted and duplicated boundary rows without the document-hash ratchet', () => {
    expect(() => validateBoundaryBijection(createEvidenceWithoutBoundaryRow())).toThrow(
      'boundary-bijection',
    );
    expect(() => validateBoundaryBijection(createEvidenceWithDuplicatedBoundaryRow())).toThrow(
      'boundary-bijection',
    );
  });

  it.each(evidenceLeafPaths)('fails closed when provenance field %s drifts', (fieldPath) => {
    const candidate = createDriftedEvidence(fieldPath);

    expect(() => validateEvidence(candidate, evidence)).toThrow(fieldPath);
  });
});
