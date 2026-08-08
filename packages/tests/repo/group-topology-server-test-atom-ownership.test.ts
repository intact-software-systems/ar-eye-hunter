import { describe, expect, it } from 'vitest';

import {
  createTopologyTestAtomOwnership,
  topologyTestAtomOwnershipDigest,
  type TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership.ts';
import { discoverTopologyTargetAtoms } from './group-topology-server-test-atom-inventory.ts';
import {
  validateTopologySupportDestinationSpecificity,
  validateTopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership-validation.ts';
import { read } from './group-topology-server-test-semantic-atoms.ts';

const commandOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts';
const fixtureOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('group topology server PR-A exact test atom ownership', () => {
  it('partitions every moved and additive target atom behind a pinned endpoint digest', () => {
    const ownership = createTopologyTestAtomOwnership();

    expect(() => validateTopologyTestAtomOwnership(ownership)).not.toThrow();
    expect(ownership.moved).toHaveLength(710);
    expect(ownership.additive).toHaveLength(89);
    expect(topologyTestAtomOwnershipDigest(ownership)).toBe(
      'ed9abaa6f5bc41a6aa2350ff15010a5ac94669de6e282b7d2baa197812aaf731',
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

    expect(() => validateTopologySupportDestinationSpecificity([weaker], targets)).toThrow(
      /less specific/u,
    );
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
