import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen snapshot helper and extracted fixture retain the same group identity, revision, and metadata responsibility.';

export const declaredTopologySnapshotRevisionAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'fixture:665:0:declaration:createGroupSnapshot:30e29d75f5487046',
    sourceFingerprint: 'declaration:createGroupSnapshot:30e29d75f5487046',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId: 'fixture:61:7:declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    ownerFingerprint: 'declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupSnapshot\u0000fixture:61:7:declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'fixture:666:19:function:createGroupSnapshot/variable:groupRef:createGroupRef:c95f65de29bc1345',
    sourceFingerprint:
      'function:createGroupSnapshot/variable:groupRef:createGroupRef:c95f65de29bc1345',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'fixture:62:19:function:createTopologyTestGroupSnapshot/variable:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/variable:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:668:19:function:createGroupSnapshot/property:stateRevision:1',
    sourceFingerprint: 'function:createGroupSnapshot/property:stateRevision:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:64:19:function:createTopologyTestGroupSnapshot/property:stateRevision:1',
    ownerFingerprint: 'function:createTopologyTestGroupSnapshot/property:stateRevision:1',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:669:37:function:createGroupSnapshot/property:causalRevision/property:groupRevision:1',
    sourceFingerprint:
      'function:createGroupSnapshot/property:causalRevision/property:groupRevision:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:65:37:function:createTopologyTestGroupSnapshot/property:causalRevision/property:groupRevision:1',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:causalRevision/property:groupRevision:1',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:669:58:function:createGroupSnapshot/property:causalRevision/property:presenceRevision:0',
    sourceFingerprint:
      'function:createGroupSnapshot/property:causalRevision/property:presenceRevision:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:65:58:function:createTopologyTestGroupSnapshot/property:causalRevision/property:presenceRevision:0',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:causalRevision/property:presenceRevision:0',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
