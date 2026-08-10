import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The frozen input helper and extracted fixture retain the same exact read, stored source, runtime entry, and fact responsibility.';

export const declaredTopologyInputReadValueAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:622:13:property:read/property:config/property:key:"config"',
    sourceFingerprint: 'property:read/property:config/property:key:"config"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:153:51:function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:153:51:function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:625:15:property:config/property:entry/property:key:"config"',
    sourceFingerprint: 'property:config/property:entry/property:key:"config"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:153:51:function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:153:51:function:createTopologyConfigMutationRead/property:config/call:runtimeEntry:"config"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:633:21:function:createConfigMutationInput/property:read/property:override:null',
    sourceFingerprint: 'function:createConfigMutationInput/property:read/property:override:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:154:34:function:createTopologyConfigMutationRead/property:override:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:override:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:634:12:function:createConfigMutationInput/property:read/property:override:null',
    sourceFingerprint: 'function:createConfigMutationInput/property:read/property:override:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:146:83:function:createTopologyConfigMutationRead/variable:override:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/variable:override:null',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:146:83:function:createTopologyConfigMutationRead/variable:override:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:636:19:property:read/property:override/property:key:"override"',
    sourceFingerprint: 'property:read/property:override/property:key:"override"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:154:54:function:createTopologyConfigMutationRead/property:override/call:runtimeEntry:"override"',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/property:override/call:runtimeEntry:"override"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:639:21:property:override/property:entry/property:key:"override"',
    sourceFingerprint: 'property:override/property:entry/property:key:"override"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:149:64:function:createTopologyConfigMutationRead/variable:override/call:storedTopologyConfig:"override"',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/variable:override/call:storedTopologyConfig:"override"',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:149:64:function:createTopologyConfigMutationRead/variable:override/call:storedTopologyConfig:"override"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:646:24:function:createConfigMutationInput/property:read/property:configGeneration:null',
    sourceFingerprint:
      'function:createConfigMutationInput/property:read/property:configGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:155:22:function:createTopologyConfigMutationRead/property:configGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:configGeneration:null',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:155:22:function:createTopologyConfigMutationRead/property:configGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:647:26:function:createConfigMutationInput/property:read/property:overrideGeneration:null',
    sourceFingerprint:
      'function:createConfigMutationInput/property:read/property:overrideGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:156:24:function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:156:24:function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:648:27:function:createConfigMutationInput/property:read/property:invariantGeneration:null',
    sourceFingerprint:
      'function:createConfigMutationInput/property:read/property:invariantGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:157:25:function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:157:25:function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'raw-literal:649:19:function:createConfigMutationInput/property:read/property:idempotency:null',
    sourceFingerprint: 'function:createConfigMutationInput/property:read/property:idempotency:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:158:17:function:createTopologyConfigMutationRead/property:idempotency:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:idempotency:null',
    disposition: 'shared-fixture',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:158:17:function:createTopologyConfigMutationRead/property:idempotency:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'fixture:650:21:function:createConfigMutationInput/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
    sourceFingerprint:
      'function:createConfigMutationInput/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'fixture:159:19:function:createTopologyConfigMutationRead/property:groupSnapshot:createTopologyTestGroupSnapshot:e55d922b3bcdd654',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/property:groupSnapshot:createTopologyTestGroupSnapshot:e55d922b3bcdd654',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId:
      'fixture:651:27:function:createConfigMutationInput/property:read/property:groupAuthorityGuard:createGroupAuthorityGuard:0ceab7ba812d3dfb',
    sourceFingerprint:
      'function:createConfigMutationInput/property:read/property:groupAuthorityGuard:createGroupAuthorityGuard:0ceab7ba812d3dfb',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'fixture:160:25:function:createTopologyConfigMutationRead/property:groupAuthorityGuard:createTopologyTestAuthorityGuard:fee0647ed1bf6812',
    ownerFingerprint:
      'function:createTopologyConfigMutationRead/property:groupAuthorityGuard:createTopologyTestAuthorityGuard:fee0647ed1bf6812',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
