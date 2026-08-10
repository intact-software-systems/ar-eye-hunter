import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same elapsed stable-expiry command, read, fact, or validation responsibility.';

export const declaredTopologyElapsedReadAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:338:16:call:deepFreeze/property:read/property:config:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:config:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:153:24:function:createTopologyConfigMutationRead/property:config:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:config:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:339:18:call:deepFreeze/property:read/property:override:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:override:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:146:83:function:createTopologyConfigMutationRead/variable:override:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/variable:override:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:146:83:function:createTopologyConfigMutationRead/variable:override:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:340:26:call:deepFreeze/property:read/property:configGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:configGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:155:22:function:createTopologyConfigMutationRead/property:configGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:configGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:155:22:function:createTopologyConfigMutationRead/property:configGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:341:28:call:deepFreeze/property:read/property:overrideGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:overrideGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:156:24:function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:156:24:function:createTopologyConfigMutationRead/property:overrideGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:342:29:call:deepFreeze/property:read/property:invariantGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:invariantGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:157:25:function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:157:25:function:createTopologyConfigMutationRead/property:invariantGeneration:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:343:21:call:deepFreeze/property:read/property:idempotency:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:idempotency:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationRead',
    ownerAtomId:
      'raw-literal:158:17:function:createTopologyConfigMutationRead/property:idempotency:null',
    ownerFingerprint: 'function:createTopologyConfigMutationRead/property:idempotency:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationRead\u0000raw-literal:158:17:function:createTopologyConfigMutationRead/property:idempotency:null',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'fixture:344:23:call:deepFreeze/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
    sourceFingerprint:
      'call:deepFreeze/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
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
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
