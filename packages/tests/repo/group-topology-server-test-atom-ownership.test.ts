import { describe, expect, it } from 'vitest';

import {
  createTopologyTestAtomOwnership,
  topologyTargetAtomKey,
  topologyTestAtomOwnershipDigest,
  type TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership.ts';
import { discoverTopologyTargetAtoms } from './group-topology-server-test-atom-inventory.ts';
import { validateTopologyTestAtomOwnership } from './group-topology-server-test-atom-ownership-validation.ts';
import { declaredTopologyTestAtomEndpoints } from './group-topology-server-test-atom-endpoint-declarations.ts';
import { read } from './group-topology-server-test-semantic-atoms.ts';

const commandOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts';
const fixtureOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';
const resolutionOwner =
  'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts';

describe('group topology server PR-A exact test atom ownership', () => {
  it('partitions every moved and additive target atom behind a pinned endpoint digest', () => {
    const ownership = createTopologyTestAtomOwnership();

    expect(() => validateTopologyTestAtomOwnership(ownership)).not.toThrow();
    expect(ownership.moved).toHaveLength(710);
    expect(ownership.additive).toHaveLength(160);
    expect(topologyTestAtomOwnershipDigest(ownership)).toBe(
      'cfa238f4bb10aa966062f493d7a497061b89bc8ef6048451c19b23c477d7a73c',
    );
  });

  it('partitions the frozen predecessor support declarations as moved source atoms', () => {
    const ownership = createTopologyTestAtomOwnership();
    const supportSources = new Set(
      ownership.moved
        .filter(({ sourceCaseId }) => sourceCaseId.startsWith('support:'))
        .map(({ sourcePath, sourceCaseId }) => `${sourcePath}:${sourceCaseId}`),
    );

    expect(supportSources).toContain(
      'packages/tests/shared-server/group-topology-config-service.test.ts:support:createGroupRef',
    );
    expect(supportSources).toContain(
      'packages/tests/shared-server/topology-app-inbox-handler.test.ts:support:topologyContext',
    );
    expect(supportSources).toHaveLength(23);
    expect(
      ownership.moved.some(({ sourceAtomId }) => sourceAtomId.startsWith('raw-literal:578:64:')),
    ).toBe(false);
  });

  it('keeps repeated support literals on their most-specific field slot', () => {
    const ownership = createTopologyTestAtomOwnership();
    const revision = ownership.moved.find(({ sourceAtomId }) =>
      sourceAtomId.includes('property:override/property:entry/property:revision:0'),
    );

    expect(revision?.ownerAtomId).toContain('property:revision:0');
  });

  it('never treats a generic same-value literal as moved semantic evidence', () => {
    const ownership = createTopologyTestAtomOwnership();
    const degreeLimit = ownership.moved.find(
      ({ sourceCaseId, sourceAtomId }) =>
        sourceCaseId ===
          'rejects compact replay receipt operation corruption against the verified command' &&
        sourceAtomId.includes('property:durableDegreeLimit:5'),
    );
    const override = ownership.moved.find(
      ({ sourceCaseId, sourceAtomId }) =>
        sourceCaseId ===
          'rejects compact replay receipt operation corruption against the verified command' &&
        sourceAtomId.includes('property:overrideDegreeLimit:null'),
    );
    const deleteTarget = ownership.moved.find(
      ({ sourceCaseId, sourceAtomId }) =>
        sourceCaseId === 'rejects an elapsed stable override expiry with explicit pure facts' &&
        sourceAtomId.includes('property:deleteTarget:null'),
    );

    expect(degreeLimit?.ownerAtomId).not.toContain('property:treeMinSize:5');
    expect(override?.ownerAtomId).not.toContain('property:ttlMs:null');
    expect(deleteTarget?.ownerAtomId).not.toContain(
      'property:resolvedOverrideExpiresAtEpochMs:null',
    );
  });

  it('materializes every contextual endpoint with reviewable family evidence', () => {
    const contextual = declaredTopologyTestAtomEndpoints.filter(({ disposition }) =>
      ['semantic', 'shared-fixture'].includes(disposition),
    );
    const declaredExact = declaredTopologyTestAtomEndpoints.filter(
      ({ disposition }) => disposition === 'declared-exact',
    );
    const falseValueOnlyMappings = contextual.filter(({ sourceAtomId }) =>
      [
        'property:durableDegreeLimit:5',
        'property:overrideDegreeLimit:null',
        'property:deleteTarget:null',
      ].some((suffix) => sourceAtomId.endsWith(suffix)),
    );

    expect(contextual).toHaveLength(210);
    expect(declaredExact).toHaveLength(56);
    expect(
      new Set(contextual.map(({ declarationReason }) => declarationReason)).size,
    ).toBeGreaterThan(10);
    expect(falseValueOnlyMappings.map(({ declarationReason }) => declarationReason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('never to an unrelated treeMinSize 5'),
        expect.stringContaining('never to an unrelated ttlMs null'),
        expect.stringContaining('never to resolved expiry null'),
      ]),
    );
  });

  it('rejects reordered target atoms instead of rebuilding ownership by traversal order', () => {
    const canonical = read(fixtureOwner);
    const changed = canonical.replace(
      "      ttlMs: operation === 'putOverride' ? 5_000 : null,\n      expiresAtEpochMs: null,",
      "      expiresAtEpochMs: null,\n      ttlMs: operation === 'putOverride' ? 5_000 : null,",
    );

    expect(changed).not.toBe(canonical);
    expect(() => createTopologyTestAtomOwnership(targetReader([[fixtureOwner, changed]]))).toThrow(
      /declared|endpoint|target atom/u,
    );
  });

  it('rejects ambiguous equal-fingerprint targets instead of selecting the first one', () => {
    const canonical = read(fixtureOwner);
    const changed = canonical.replace(
      '      expiresAtEpochMs: null,',
      '      expiresAtEpochMs: null ?? null,',
    );

    expect(changed).not.toBe(canonical);
    expect(() => createTopologyTestAtomOwnership(targetReader([[fixtureOwner, changed]]))).toThrow(
      /ambiguous|declared|endpoint/u,
    );
  });

  it('rejects a generic same-value field swap with unchanged literal counts', () => {
    const canonical = read(resolutionOwner);
    const changed = canonical
      .replace('      degreeLimit: 5,', '      degreeLimit: 6,')
      .replace('      treeMinSize: 6,', '      treeMinSize: 5,');

    expect(changed).not.toBe(canonical);
    expect(() =>
      createTopologyTestAtomOwnership(targetReader([[resolutionOwner, changed]])),
    ).toThrow(/declared|endpoint|target atom/u);
  });

  it('rejects a generic literal target when a field-slot target is available', () => {
    const ownership = createTopologyTestAtomOwnership();
    const revision = ownership.moved.find(({ sourceAtomId }) =>
      sourceAtomId.includes('property:override/property:entry/property:revision:0'),
    )!;
    const targets = discoverTopologyTargetAtoms();
    const timestamp = targets.find(({ id }) => id.includes('property:updatedTimestamp'))!;
    const weaker = {
      ...revision,
      ownerPath: timestamp.ownerPath,
      ownerCaseId: timestamp.ownerCaseId,
      ownerAtomId: timestamp.id,
      ownerKind: timestamp.kind,
      ownerFingerprint: timestamp.fingerprint,
      ownerMatchKeys: timestamp.matchKeys,
    };

    const changed: TopologyTestAtomOwnership = {
      ...ownership,
      moved: ownership.moved.map((endpoint) => (endpoint === revision ? weaker : endpoint)),
    };

    expect(() => validateTopologyTestAtomOwnership(changed)).toThrow(
      /declared atom endpoint|target claim/u,
    );
  });

  it('rejects a semantic declaration supported only by a bare equal value', () => {
    const ownership = createTopologyTestAtomOwnership();
    const semantic = ownership.moved.find(({ disposition }) => disposition === 'semantic')!;
    const genericOnly = {
      ...semantic,
      sourceMatchKeys: ['literal:null'],
      ownerMatchKeys: ['literal:null'],
    };
    const changed: TopologyTestAtomOwnership = {
      ...ownership,
      moved: ownership.moved.map((endpoint) => (endpoint === semantic ? genericOnly : endpoint)),
    };

    expect(() => validateTopologyTestAtomOwnership(changed)).toThrow(/specific normalized key/u);
  });

  it('fails closed when a target literal endpoint is deleted', () => {
    const ownership = createTopologyTestAtomOwnership();
    const canonical = read(commandOwner);
    const changed = canonical.replace('            unexpected: true,\n', '');

    expect(changed).not.toBe(canonical);
    expect(() =>
      validateTopologyTestAtomOwnership(ownership, targetReader([[commandOwner, changed]])),
    ).toThrow(/target atom/u);
  });

  it('fails closed when an assertion is replaced without changing aggregate counts', () => {
    const ownership = createTopologyTestAtomOwnership();
    const canonical = read(commandOwner);
    const changed = canonical.replace('.toEqual(', '.toStrictEqual(');

    expect(changed).not.toBe(canonical);
    expect(() =>
      validateTopologyTestAtomOwnership(ownership, targetReader([[commandOwner, changed]])),
    ).toThrow(/target atom/u);
  });

  it('fails closed when one target endpoint is claimed twice', () => {
    const ownership = createTopologyTestAtomOwnership();
    const duplicate: TopologyTestAtomOwnership = {
      ...ownership,
      moved: [...ownership.moved, ownership.moved[0]],
    };

    expect(() => validateTopologyTestAtomOwnership(duplicate)).toThrow(/target claim/u);
  });

  it('rejects consolidation metadata on a uniquely claimed target', () => {
    const ownership = createTopologyTestAtomOwnership();
    const claimsByTarget = Map.groupBy(ownership.moved, topologyTargetAtomKey);
    const uniqueExact = ownership.moved.find(
      (endpoint) =>
        endpoint.disposition === 'exact' &&
        claimsByTarget.get(topologyTargetAtomKey(endpoint))?.length === 1,
    )!;
    const changed: TopologyTestAtomOwnership = {
      ...ownership,
      moved: ownership.moved.map((endpoint) =>
        endpoint === uniqueExact
          ? {
              ...endpoint,
              consolidationId: 'support:invented-unique-claim',
              consolidationReason: 'Invented duplicate evidence.',
            }
          : endpoint,
      ),
    };

    expect(uniqueExact.consolidationId).toBeNull();
    expect(() => validateTopologyTestAtomOwnership(changed)).toThrow(/unique target claim/u);
  });

  it('pins the exact consolidation identifier and reason for duplicate target claims', () => {
    const ownership = createTopologyTestAtomOwnership();
    const claimsByTarget = Map.groupBy(ownership.moved, topologyTargetAtomKey);
    const duplicateClaims = [...claimsByTarget.values()].find(
      (claims) => claims.length > 1 && claims[0]?.ownerCaseId.startsWith('support:'),
    )!;
    for (const replacement of [
      { consolidationId: 'support:invented-duplicate-target' },
      { consolidationReason: 'Invented duplicate evidence.' },
    ]) {
      const changed: TopologyTestAtomOwnership = {
        ...ownership,
        moved: ownership.moved.map((endpoint) =>
          duplicateClaims.includes(endpoint) ? { ...endpoint, ...replacement } : endpoint,
        ),
      };

      expect(() => validateTopologyTestAtomOwnership(changed)).toThrow(/exact consolidation/u);
    }
  });

  it('fails closed when a target test case has no moved or Task-2 classification', () => {
    const ownership = createTopologyTestAtomOwnership();
    const canonical = read(commandOwner);
    const changed = `${canonical}\nit('unclassified target coverage', () => {\n  expect(true).toBe(true);\n});\n`;

    expect(() =>
      validateTopologyTestAtomOwnership(ownership, targetReader([[commandOwner, changed]])),
    ).toThrow(/Unclassified target test case/u);
  });

  it('fails closed when an eligible support function has no declaration', () => {
    const ownership = createTopologyTestAtomOwnership();
    const canonical = read(fixtureOwner);
    const changed = `${canonical}\nfunction unclassifiedTopologyFixture(): null {\n  return null;\n}\n`;

    expect(() =>
      validateTopologyTestAtomOwnership(ownership, targetReader([[fixtureOwner, changed]])),
    ).toThrow(/Unclassified target support declaration/u);
  });
});

function targetReader(
  changes: readonly (readonly [string, string])[],
): (ownerPath: string) => string {
  const changedByPath = new Map(changes);
  return (ownerPath) => changedByPath.get(ownerPath) ?? read(ownerPath);
}
