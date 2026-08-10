import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen helper declaration and extracted support owner retain the same group-ref, freeze, command, or identity responsibility.';

export const declaredTopologySupportAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupRef',
    sourceAtomId: 'fixture:568:0:declaration:createGroupRef:bf1bdbe75eef00b1',
    sourceFingerprint: 'declaration:createGroupRef:bf1bdbe75eef00b1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupRef',
    ownerAtomId: 'fixture:53:7:declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    ownerFingerprint: 'declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupRef\u0000fixture:53:7:declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupRef',
    sourceAtomId: 'raw-literal:570:19:function:createGroupRef/property:applicationId:"app-1"',
    sourceFingerprint: 'function:createGroupRef/property:applicationId:"app-1"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupRef',
    ownerAtomId:
      'raw-literal:55:19:function:createTopologyTestGroupRef/property:applicationId:"app-1"',
    ownerFingerprint: 'function:createTopologyTestGroupRef/property:applicationId:"app-1"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupRef',
    sourceAtomId: 'raw-literal:571:17:function:createGroupRef/property:workspaceId:"workspace-1"',
    sourceFingerprint: 'function:createGroupRef/property:workspaceId:"workspace-1"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupRef',
    ownerAtomId:
      'raw-literal:56:17:function:createTopologyTestGroupRef/property:workspaceId:"workspace-1"',
    ownerFingerprint: 'function:createTopologyTestGroupRef/property:workspaceId:"workspace-1"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupRef',
    sourceAtomId: 'raw-literal:572:13:function:createGroupRef/property:groupId:"room-1"',
    sourceFingerprint: 'function:createGroupRef/property:groupId:"room-1"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupRef',
    ownerAtomId: 'raw-literal:57:13:function:createTopologyTestGroupRef/property:groupId:"room-1"',
    ownerFingerprint: 'function:createTopologyTestGroupRef/property:groupId:"room-1"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId: 'fixture:740:0:declaration:createGroupAuthorityGuard:58b24b0210476871',
    sourceFingerprint: 'declaration:createGroupAuthorityGuard:58b24b0210476871',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId: 'fixture:112:7:declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    ownerFingerprint: 'declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestAuthorityGuard\u0000fixture:112:7:declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId: 'raw-literal:740:46:function:createGroupAuthorityGuard:0',
    sourceFingerprint: 'function:createGroupAuthorityGuard:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId: 'raw-literal:112:60:function:createTopologyTestAuthorityGuard:0',
    ownerFingerprint: 'function:createTopologyTestAuthorityGuard:0',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId:
      'fixture:741:16:function:createGroupAuthorityGuard/variable:group:createGroupSnapshot:64a9d31219f23fd8',
    sourceFingerprint:
      'function:createGroupAuthorityGuard/variable:group:createGroupSnapshot:64a9d31219f23fd8',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId:
      'fixture:113:16:function:createTopologyTestAuthorityGuard/variable:group:createTopologyTestGroupSnapshot:e55d922b3bcdd654',
    ownerFingerprint:
      'function:createTopologyTestAuthorityGuard/variable:group:createTopologyTestGroupSnapshot:e55d922b3bcdd654',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId:
      'fixture:743:14:function:createGroupAuthorityGuard/property:groupRef:createGroupRef:c95f65de29bc1345',
    sourceFingerprint:
      'function:createGroupAuthorityGuard/property:groupRef:createGroupRef:c95f65de29bc1345',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId:
      'fixture:115:14:function:createTopologyTestAuthorityGuard/property:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    ownerFingerprint:
      'function:createTopologyTestAuthorityGuard/property:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId:
      'raw-literal:744:25:function:createGroupAuthorityGuard/property:causalGroupRevision:1',
    sourceFingerprint: 'function:createGroupAuthorityGuard/property:causalGroupRevision:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId:
      'raw-literal:116:25:function:createTopologyTestAuthorityGuard/property:causalGroupRevision:1',
    ownerFingerprint: 'function:createTopologyTestAuthorityGuard/property:causalGroupRevision:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupAuthorityGuard',
    sourceAtomId:
      'raw-literal:746:11:function:createGroupAuthorityGuard/property:entry/property:key:"group-authority"',
    sourceFingerprint:
      'function:createGroupAuthorityGuard/property:entry/property:key:"group-authority"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId:
      'raw-literal:118:11:function:createTopologyTestAuthorityGuard/property:entry/property:key:"group-authority"',
    ownerFingerprint:
      'function:createTopologyTestAuthorityGuard/property:entry/property:key:"group-authority"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:deepFreeze',
    sourceAtomId: 'fixture:755:0:declaration:deepFreeze:508e8982f831e522',
    sourceFingerprint: 'declaration:deepFreeze:508e8982f831e522',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:deepFreezeTopologyTestValue',
    ownerAtomId: 'fixture:127:7:declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    ownerFingerprint: 'declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:deepFreezeTopologyTestValue\u0000fixture:127:7:declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:deepFreeze',
    sourceAtomId: 'raw-literal:756:32:function:deepFreeze:"object"',
    sourceFingerprint: 'function:deepFreeze:"object"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:deepFreezeTopologyTestValue',
    ownerAtomId: 'raw-literal:128:32:function:deepFreezeTopologyTestValue:"object"',
    ownerFingerprint: 'function:deepFreezeTopologyTestValue:"object"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:deepFreeze',
    sourceAtomId: 'fixture:759:6:function:deepFreeze:deepFreeze:325703b8546813aa',
    sourceFingerprint: 'function:deepFreeze:deepFreeze:325703b8546813aa',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:deepFreezeTopologyTestValue',
    ownerAtomId:
      'fixture:131:6:function:deepFreezeTopologyTestValue:deepFreezeTopologyTestValue:2e78cc0edffaa7b3',
    ownerFingerprint:
      'function:deepFreezeTopologyTestValue:deepFreezeTopologyTestValue:2e78cc0edffaa7b3',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
