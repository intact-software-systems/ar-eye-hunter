import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The repeated frozen snapshot audit fields consolidate onto the extracted canonical audit-stamp responsibility.';

export const declaredTopologySnapshotAuditAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId:
      'raw-literal:691:25:function:createGroupSnapshot/property:group/property:purgeAfterEpochMs:null',
    sourceFingerprint:
      'function:createGroupSnapshot/property:group/property:purgeAfterEpochMs:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:87:25:function:createTopologyTestGroupSnapshot/property:group/property:purgeAfterEpochMs:null',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:group/property:purgeAfterEpochMs:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:693:19:property:group/property:created/property:atEpochMs:1',
    sourceFingerprint: 'property:group/property:created/property:atEpochMs:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:atEpochMs:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:201:15:function:topologyTestAuditStamp/property:atEpochMs:1',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:694:23:property:created/property:actor/property:kind:"principal"',
    sourceFingerprint: 'property:created/property:actor/property:kind:"principal"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId:
      'raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:202:19:function:topologyTestAuditStamp/property:actor/property:kind:"principal"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:694:49:property:created/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'property:created/property:actor/property:principalId:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId:
      'raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    ownerFingerprint:
      'function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupSnapshot\u0000raw-literal:94:21:function:createTopologyTestGroupSnapshot/property:members/property:principalId:"owner"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:695:16:property:group/property:created/property:reason:null',
    sourceFingerprint: 'property:group/property:created/property:reason:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:reason:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:203:12:function:topologyTestAuditStamp/property:reason:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:696:17:property:group/property:created/property:traceId:null',
    sourceFingerprint: 'property:group/property:created/property:traceId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:traceId:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:204:13:function:topologyTestAuditStamp/property:traceId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:697:19:property:group/property:created/property:requestId:null',
    sourceFingerprint: 'property:group/property:created/property:requestId:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId: 'raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:requestId:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:topologyTestAuditStamp\u0000raw-literal:205:15:function:topologyTestAuditStamp/property:requestId:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:700:19:property:group/property:updated/property:atEpochMs:1',
    sourceFingerprint: 'property:group/property:updated/property:atEpochMs:1',
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
    sourceAtomId: 'raw-literal:701:23:property:updated/property:actor/property:kind:"principal"',
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
    sourceAtomId: 'raw-literal:701:49:property:updated/property:actor/property:principalId:"owner"',
    sourceFingerprint: 'property:updated/property:actor/property:principalId:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:topologyTestAuditStamp',
    ownerAtomId:
      'raw-literal:202:54:function:topologyTestAuditStamp/property:actor/property:principalId:"owner"',
    ownerFingerprint: 'function:topologyTestAuditStamp/property:actor/property:principalId:"owner"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createGroupSnapshot',
    sourceAtomId: 'raw-literal:702:16:property:group/property:updated/property:reason:null',
    sourceFingerprint: 'property:group/property:updated/property:reason:null',
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
    sourceAtomId: 'raw-literal:703:17:property:group/property:updated/property:traceId:null',
    sourceFingerprint: 'property:group/property:updated/property:traceId:null',
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
    sourceAtomId: 'raw-literal:704:19:property:group/property:updated/property:requestId:null',
    sourceFingerprint: 'property:group/property:updated/property:requestId:null',
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
    sourceAtomId:
      'raw-literal:710:21:function:createGroupSnapshot/property:members/property:principalId:"owner"',
    sourceFingerprint: 'function:createGroupSnapshot/property:members/property:principalId:"owner"',
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
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
