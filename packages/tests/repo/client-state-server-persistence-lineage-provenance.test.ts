import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const prAResultingMain = '2fdba024bb347622727d337eb06fc13d2fe129fc';
const manifestPath = 'plans/repo-style-lineages/client-state-server-persistence.json';
const provenancePath = 'plans/repo-style-lineages/client-state-server-persistence-provenance.md';
const canonicalTargets = [
  'packages/shared-server/rallar-system/client-state/client-presence-state.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts',
  'packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts',
  'packages/shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts',
  'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts',
] as const;

const expectedManifest = {
  version: 1,
  lineages: [
    lineage(
      'packages/shared-server/rallar-system/client-presence-state.ts',
      '60b0ecdd48e29ba4bbd3735e48ec3ad9a0741a27',
      ['packages/shared-server/rallar-system/client-state/client-presence-state.ts'],
    ),
    lineage(
      'packages/shared-server/rallar-system/client-state-storage-keys.ts',
      '677e87f18f06c450b4b412e1ae438ea5b9d850c3',
      [
        'packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts',
      ],
    ),
    lineage(
      'packages/shared-server/rallar-system/repositories/ClientStateRepository.ts',
      '9681469561f33b48cd5320dc7ad013c715c19ebe',
      [
        'packages/shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts',
        'packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts',
        'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts',
        'packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts',
        'packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts',
        'packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts',
        'packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts',
      ],
    ),
    lineage(
      'packages/shared-server/rallar-system/services/client-state-mutations.ts',
      'e4c8219a22ba6e3d47e3b139d44546b1fda436f0',
      [
        'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts',
        'packages/shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts',
      ],
    ),
    lineage(
      'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
      'b5e091fe588f88fa63eadf1d4c24d7c04aa3df00',
      [
        'packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts',
      ],
    ),
  ],
};

const expectedEvidence = parseEvidence(`
presence|packages/shared-server/rallar-system/client-presence-state.ts|1-13|313054037da652cdb036bf545c20da0bb44248792bd6910f4849b4d36607f19b|packages/shared-server/rallar-system/client-state/client-presence-state.ts|3-7|ceefccbb1ea20963abea667758cf84ff0e5f1b37988830a7572994b1ac3c6e5d|cc9c3db7e46aa1d6a18b2610b42b256628bbcd191f46f80f0d1c8b20e0d87b06
storage-key-builders|packages/shared-server/rallar-system/client-state-storage-keys.ts|7-56|40f9c2e746d6604478f2df084e90236e91cbc18188ecd3c5cff9f3dee3cbfc3f|packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts|8-50|7fcc8933af694c48dffb67ba4417ad688449ba18a78c418328ea583bb15068c0|056a23d01e79ceed2c39810e05dce5e92bdc97aa7eed3f4a4490280813183e51
storage-key-decoders|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|729-835|11f4bd53d1f3ddede66d6f33f37b54e0f92c0e7958a8394d3e60a85452168a68|packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts|53-148|7c1c56e29422d722c8e59c642ca66ecb43fb91731319c8d4df69b4a4c58f1d19|056a23d01e79ceed2c39810e05dce5e92bdc97aa7eed3f4a4490280813183e51
runtime-namespaces|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|63-66|0cd45938e25ca984be2392a5157739a49014c79b02e470c9a14145eedff8262e|packages/shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts|1-4|8ccff134e75132bdf76b025b943fba6aa13a9d81c8f89a8de67fd5b365190026|fee02494a6fe1aa2556157ab33d92fdaed2575f30a884088caa358ceb9817733
repository-reads|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|138-172,200-208,275-289,316-323,351-379,398-464,550-688|0b1504daf10949e7bf5aab098de99743fc2935ee0acc6f25f3b02ba2fab87aef|packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts|59-313|4bde9b7f661848dbd2dded0032c7696a45b1140a5db09b49b01631d5672772e5|42235ec4b0bc59c68618ed3441bf83546c948fda6937981f4944da37c1b1e5f6
snapshot-assembly|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|526-548,690-698|643246917e2cb7ac78432e24b2dd4bcd6f04a4e58c831673c8e3fbe82c1f130a|packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts|25-60|e919bf88d02369c7331c7ccc162a920b7e53604b3e77560f80471672c2272de2|59c6a68ce7340283892211bcc7e0a50762de0f822d5aae0b881a57307f92ae41
snapshot-reads|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|210-262,466-524|d455f565ba2d9206804ad2c2ed20cb705dd0d66df397e698fbf9ef05ee3c0a91|packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts|38-130,150-160|0cc7a51d68de21270fbba4a9e35d7b08a13a180ba271c164394dc614902a1021|d7d97e1c60851dfdfdca5f90ced47c29c67027120d85ae34eadded6a7afd0169
repository-writes|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|77-84,123-136,175-198,264-273,291-315,325-348,381-396,420-434|a7dddf5e820b728831be0d176085470ceeafe2c96fae81080363b94c66decfd2|packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts|66-73,80-201|69661f7c02ad450864ae0ff8fc801b98aa350a933d7cb287dd5dd19c905e4ca1|32d7686ed680946ec2dd9b91f9dcda95c3cd7af64a6e13b3ca5bd7325d5ca4d6
persistence-codec|packages/shared-server/rallar-system/services/client-state-mutations.ts|82-248,305-399|550d9ed1e9a963fa983c8ee463513ab2bb2111223de8157d2997cafd83575ea3|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts|29-299|bfa75db9f8e7252bb1ed30f25528d9c0b0351056cf4bc9f599ef48fb0b78f128|25ae1feb761c33b2b57850ce595ad3184d8593ce1cba2c482d7f9bc8295b257a
persistence-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|250-303|d02d870ba3627e19188f2c70584bf5fb30de34550c6754fee0a226e2892686f6|packages/shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts|25-78|c2038a7e02ffe668115fcefc893454a9e4048c917fd7b11dd66157d5224eecee|eacda2e36a24850af797e390c423d8446b6660da9a1b7530243547173e7aee5a
snapshot-contracts|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|68-75|197394a826f8abd74341b997346985ed302629d2605856ce3c0bfc9c0444f0a9|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|7-14|df25c7d7ce2e85f2c890e4182741cad92fac0db10fc5c1412f7eb828dcc69ef0|697d7bef8f749edc75466c63e837726cc590a87cdc389682770ca2af6a635f8c
receipt-contracts|packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts|191-210|835cf42a672ba2230086f859ec955e163ce0b0d5aeb8449058ce470a0000cf63|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|16-35|97799547a0f89e14bc4526ca5e7f00fa47d3704badac6395b962b97ecfff212d|697d7bef8f749edc75466c63e837726cc590a87cdc389682770ca2af6a635f8c
invariant-contracts|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|86-121,674-688|daf9bd94d7405cd0265d6e9379674becd9366a609d12100ed4a5018d72663a1b|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|37-80|f8ae05bc65484b6ff87fe46688ab09741f044d0ed26c11776035f861dbf890e7|697d7bef8f749edc75466c63e837726cc590a87cdc389682770ca2af6a635f8c
`);

describe('client-state PR B persistence lineage provenance', () => {
  it('audits every manifest row against exact source and target regions', () => {
    expect(JSON.parse(read(manifestPath))).toEqual(expectedManifest);
    const evidence = readEvidence();
    expect(evidence).toEqual(expectedEvidence);
    expect([...new Set(evidence.map((entry) => entry.target))]).toEqual(canonicalTargets);
    expect(
      evidence.filter((entry) => entry.target.endsWith('client-state-storage-keys.ts')),
    ).toHaveLength(2);
    expect(
      evidence.filter((entry) => entry.target.endsWith('client-state-persistence-contracts.ts')),
    ).toHaveLength(3);
    validateEvidence(evidence);
  });

  it('fails closed for altered region content and semantic additions', () => {
    const evidence = readEvidence();
    const alteredRegion = new Map([
      [evidence[0].target, read(evidence[0].target).replace("return 'offline';", "return 'away';")],
    ]);
    const semanticAddition = new Map([
      [
        evidence[1].target,
        `${read(evidence[1].target)}\nexport const unrelatedPersistenceGlue = true;\n`,
      ],
    ]);
    const wrongTargetRegion = structuredClone(evidence);
    wrongTargetRegion[0].targetRegions = '1-7';

    expect(() => validateEvidence(evidence, alteredRegion)).toThrow('target region hash presence');
    expect(() => validateEvidence(evidence, semanticAddition)).toThrow(
      'target file hash storage-key-builders',
    );
    expect(() => validateEvidence(wrongTargetRegion)).toThrow('exact evidence inventory');
  });
});

function lineage(path: string, blob: string, targets: readonly string[]) {
  return {
    mergeBase: prAResultingMain,
    source: { path, blob },
    targets,
  };
}

function readEvidence(): readonly EvidenceRecord[] {
  const provenance = read(provenancePath);
  const block = provenance.match(/## Machine evidence\n\n```text\n([\s\S]+?)\n```/)?.[1];
  if (!block) throw new Error('Missing PR B persistence machine evidence');
  return parseEvidence(block);
}

function parseEvidence(block: string): readonly EvidenceRecord[] {
  return block
    .trim()
    .split('\n')
    .map((line) => {
      const [
        id,
        source,
        sourceRegions,
        sourceHash,
        target,
        targetRegions,
        targetHash,
        targetFileHash,
      ] = line.split('|');
      return {
        id,
        source,
        sourceRegions,
        sourceHash,
        target,
        targetRegions,
        targetHash,
        targetFileHash,
      };
    });
}

function validateEvidence(
  evidence: readonly EvidenceRecord[],
  targetOverrides = new Map<string, string>(),
): void {
  if (JSON.stringify(evidence) !== JSON.stringify(expectedEvidence)) {
    throw new Error('exact evidence inventory');
  }
  const manifest = JSON.parse(read(manifestPath)) as PersistenceManifest;
  for (const entry of evidence) {
    const source = manifest.lineages.find((lineage) => lineage.source.path === entry.source);
    if (!source || !source.targets.includes(entry.target)) {
      throw new Error(`manifest ownership ${entry.id}`);
    }
    if (readBlob(entry.source) !== source.source.blob) {
      throw new Error(`source blob ${entry.id}`);
    }
    if (hashRegions(readSource(entry.source), entry.sourceRegions) !== entry.sourceHash) {
      throw new Error(`source region hash ${entry.id}`);
    }
    const target = targetOverrides.get(entry.target) ?? read(entry.target);
    if (hashRegions(target, entry.targetRegions) !== entry.targetHash) {
      throw new Error(`target region hash ${entry.id}`);
    }
    if (hash(target) !== entry.targetFileHash) {
      throw new Error(`target file hash ${entry.id}`);
    }
  }
}

function readBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function readSource(filePath: string): string {
  return execFileSync('git', ['show', `${prAResultingMain}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function hashRegions(source: string, regions: string): string {
  const lines = source.split('\n');
  const selected = regions.split(',').map((region) => {
    const [start, end] = region.split('-').map(Number);
    if (!start || !end || start > end || end > lines.length) {
      throw new Error(`invalid region ${region}`);
    }
    return lines.slice(start - 1, end).join('\n');
  });
  return hash(selected.join('\n--- region ---\n'));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

interface EvidenceRecord {
  id: string;
  source: string;
  sourceRegions: string;
  sourceHash: string;
  target: string;
  targetRegions: string;
  targetHash: string;
  targetFileHash: string;
}

interface PersistenceManifest {
  version: number;
  lineages: readonly Readonly<{
    mergeBase: string;
    source: Readonly<{ path: string; blob: string }>;
    targets: readonly string[];
  }>[];
}
