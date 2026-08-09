import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen input helper and extracted fixture retain the same exact read, stored source, runtime entry, and fact responsibility.';

export const declaredTopologyInputRuntimeValueAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:629:20:property:config/property:entry/property:revision:0',
    sourceFingerprint: 'property:config/property:entry/property:revision:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:194:16:function:runtimeEntry/property:entry/property:revision:0',
    ownerFingerprint: 'function:runtimeEntry/property:entry/property:revision:0',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:runtimeEntry\u0000raw-literal:194:16:function:runtimeEntry/property:entry/property:revision:0',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:642:43:property:entry/property:updatedTimestamp/call:.toISOString:0',
    sourceFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:193:33:property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:runtimeEntry\u0000raw-literal:193:33:property:entry/property:updatedTimestamp/call:.toISOString:0',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:643:26:property:override/property:entry/property:revision:0',
    sourceFingerprint: 'property:override/property:entry/property:revision:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:194:16:function:runtimeEntry/property:entry/property:revision:0',
    ownerFingerprint: 'function:runtimeEntry/property:entry/property:revision:0',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:runtimeEntry\u0000raw-literal:194:16:function:runtimeEntry/property:entry/property:revision:0',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:654:26:function:createConfigMutationInput/property:facts/property:requestedAtEpochMs:1000',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:requestedAtEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:43:24:function:createTopologyConfigMutationTestInput/variable:facts/property:requestedAtEpochMs:1000',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:requestedAtEpochMs:1000',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:43:24:function:createTopologyConfigMutationTestInput/variable:facts/property:requestedAtEpochMs:1000',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:655:24:function:createConfigMutationInput/property:facts/property:policyNowEpochMs:1000',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:policyNowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:44:22:function:createTopologyConfigMutationTestInput/variable:facts/property:policyNowEpochMs:1000',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:policyNowEpochMs:1000',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:656:29:property:facts/property:commandHash/call:.repeat:"c"',
    sourceFingerprint: 'property:facts/property:commandHash/call:.repeat:"c"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId: 'raw-literal:45:27:variable:facts/property:commandHash/call:.repeat:"c"',
    ownerFingerprint: 'variable:facts/property:commandHash/call:.repeat:"c"',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:45:27:variable:facts/property:commandHash/call:.repeat:"c"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:656:40:property:facts/property:commandHash/call:.repeat:64',
    sourceFingerprint: 'property:facts/property:commandHash/call:.repeat:64',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId: 'raw-literal:45:38:variable:facts/property:commandHash/call:.repeat:64',
    ownerFingerprint: 'variable:facts/property:commandHash/call:.repeat:64',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:45:38:variable:facts/property:commandHash/call:.repeat:64',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:657:20:function:createConfigMutationInput/property:facts/property:attemptCount:1',
    sourceFingerprint: 'function:createConfigMutationInput/property:facts/property:attemptCount:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:46:18:function:createTopologyConfigMutationTestInput/variable:facts/property:attemptCount:1',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:attemptCount:1',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:46:18:function:createTopologyConfigMutationTestInput/variable:facts/property:attemptCount:1',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:658:23:function:createConfigMutationInput/property:facts/property:isPlatformAdmin:false',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:isPlatformAdmin:false',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:47:21:function:createTopologyConfigMutationTestInput/variable:facts/property:isPlatformAdmin:false',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:isPlatformAdmin:false',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:47:21:function:createTopologyConfigMutationTestInput/variable:facts/property:isPlatformAdmin:false',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:659:60:function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:"putOverride"',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:"putOverride"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:48:52:function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:"putOverride"',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:"putOverride"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:659:76:function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:6000',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:6000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:48:68:function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:6000',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:6000',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:48:68:function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:6000',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:659:84:function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    sourceFingerprint:
      'function:createConfigMutationInput/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:48:76:function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
