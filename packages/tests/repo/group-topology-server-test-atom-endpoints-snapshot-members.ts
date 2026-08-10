import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen snapshot helper and extracted fixture retain the same owner/member role, lifecycle, and membership responsibility.';

export const declaredTopologySnapshotMemberAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:711:14:function:createGroupSnapshot/property:members/property:role:"owner"',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:role:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:95:14:function:createTopologyTestGroupSnapshot/property:members/property:role:"owner"',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:role:"owner"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:712:16:function:createGroupSnapshot/property:members/property:status:"active"',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:status:"active"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:96:16:function:createTopologyTestGroupSnapshot/property:members/property:status:"active"',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:status:"active"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:713:30:function:createGroupSnapshot/property:members/property:invitedByPrincipalId:null',
    sourceFingerprint:
      'function:createGroupSnapshot/property:members/property:invitedByPrincipalId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:97:30:function:createTopologyTestGroupSnapshot/property:members/property:invitedByPrincipalId:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:invitedByPrincipalId:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:714:36:function:createGroupSnapshot/property:members/property:invitationExpiresAtEpochMs:null',
    sourceFingerprint:
      'function:createGroupSnapshot/property:members/property:invitationExpiresAtEpochMs:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:98:36:function:createTopologyTestGroupSnapshot/property:members/property:invitationExpiresAtEpochMs:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:invitationExpiresAtEpochMs:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:715:14:function:createGroupSnapshot/property:members/property:left:null',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:left:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:99:14:function:createTopologyTestGroupSnapshot/property:members/property:left:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:left:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:716:17:function:createGroupSnapshot/property:members/property:removed:null',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:removed:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:100:17:function:createTopologyTestGroupSnapshot/property:members/property:removed:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:removed:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:717:16:function:createGroupSnapshot/property:members/property:banned:null',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:banned:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:101:16:function:createTopologyTestGroupSnapshot/property:members/property:banned:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:banned:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:719:21:property:members/property:joined/property:atEpochMs:1',
    sourceFingerprint: 'property:members/property:joined/property:atEpochMs:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:atEpochMs:1',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:720:25:property:joined/property:actor/property:kind:"principal"',
    sourceFingerprint: 'property:joined/property:actor/property:kind:"principal"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId:
      'raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:720:51:property:joined/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'property:joined/property:actor/property:principalId:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupSnapshot\u0000raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:721:18:property:members/property:joined/property:reason:null',
    sourceFingerprint: 'property:members/property:joined/property:reason:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:reason:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:722:19:property:members/property:joined/property:traceId:null',
    sourceFingerprint: 'property:members/property:joined/property:traceId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:traceId:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:723:21:property:members/property:joined/property:requestId:null',
    sourceFingerprint: 'property:members/property:joined/property:requestId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:requestId:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:726:21:property:members/property:updated/property:atEpochMs:1',
    sourceFingerprint: 'property:members/property:updated/property:atEpochMs:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:atEpochMs:1',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:727:25:property:updated/property:actor/property:kind:"principal"',
    sourceFingerprint: 'property:updated/property:actor/property:kind:"principal"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId:
      'raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:727:51:property:updated/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'property:updated/property:actor/property:principalId:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupSnapshot\u0000raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:728:18:property:members/property:updated/property:reason:null',
    sourceFingerprint: 'property:members/property:updated/property:reason:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:reason:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:729:19:property:members/property:updated/property:traceId:null',
    sourceFingerprint: 'property:members/property:updated/property:traceId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:traceId:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:730:21:property:members/property:updated/property:requestId:null',
    sourceFingerprint: 'property:members/property:updated/property:requestId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:requestId:null',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:735:17:function:createGroupSnapshot/property:memberCount:1',
    sourceFingerprint: 'function:createGroupSnapshot/property:memberCount:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:107:17:function:createTopologyTestGroupSnapshot/property:memberCount:1',
    ownerFingerprint: 'function:createTopologyTestGroupSnapshot/property:memberCount:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:736:23:function:createGroupSnapshot/property:onlineMemberCount:0',
    sourceFingerprint: 'function:createGroupSnapshot/property:onlineMemberCount:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:108:23:function:createTopologyTestGroupSnapshot/property:onlineMemberCount:0',
    ownerFingerprint: 'function:createTopologyTestGroupSnapshot/property:onlineMemberCount:0',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
