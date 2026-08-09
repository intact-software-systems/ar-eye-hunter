import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The pinned endpoint retains the same exact config-mutation literal in its mapped compute, validation, idempotency, or resolution responsibility; declaration disambiguates repeated values.';

export const declaredTopologyExactConfigMutationAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:44:34:property:input/property:config/property:topologyKind:"tree"',
    sourceFingerprint: 'property:input/property:config/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId: 'raw-literal:154:32:property:input/property:config/property:topologyKind:"tree"',
    ownerFingerprint: 'property:input/property:config/property:topologyKind:"tree"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId: 'raw-literal:154:28::"write"',
    sourceFingerprint: ':"write"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId: 'raw-literal:67:28::"write"',
    ownerFingerprint: ':"write"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId: 'raw-literal:166:29::"write"',
    sourceFingerprint: ':"write"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId: 'raw-literal:79:29::"write"',
    ownerFingerprint: ':"write"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId: 'raw-literal:266:39:property:entry/property:updatedTimestamp/call:.toISOString:0',
    sourceFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:94:33:property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:416:34:call:expect().toBeGreaterThan:1',
    sourceFingerprint: 'call:expect().toBeGreaterThan:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    ownerAtomId: 'raw-literal:123:34:call:expect().toBeGreaterThan:1',
    ownerFingerprint: 'call:expect().toBeGreaterThan:1',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:424:41:call:expect().toBeGreaterThan:1',
    sourceFingerprint: 'call:expect().toBeGreaterThan:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    ownerAtomId: 'raw-literal:131:41:call:expect().toBeGreaterThan:1',
    ownerFingerprint: 'call:expect().toBeGreaterThan:1',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:427:33:call:expect().not.toContain:".begin("',
    sourceFingerprint: 'call:expect().not.toContain:".begin("',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    ownerAtomId: 'raw-literal:134:33:call:expect().not.toContain:".begin("',
    ownerFingerprint: 'call:expect().not.toContain:".begin("',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:428:60:call:expect().not.toContain:".begin("',
    sourceFingerprint: 'call:expect().not.toContain:".begin("',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    ownerAtomId: 'raw-literal:135:60:call:expect().not.toContain:".begin("',
    ownerFingerprint: 'call:expect().not.toContain:".begin("',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:331:34:property:input/property:config/property:topologyKind:"tree"',
    sourceFingerprint: 'property:input/property:config/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId: 'raw-literal:36:49:property:input/property:config/property:topologyKind:"tree"',
    ownerFingerprint: 'property:input/property:config/property:topologyKind:"tree"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:36:49:property:input/property:config/property:topologyKind:"tree"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'support:createConfigMutationInput',
    sourceAtomId: 'raw-literal:628:37:property:entry/property:updatedTimestamp/call:.toISOString:0',
    sourceFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:193:33:property:entry/property:updatedTimestamp/call:.toISOString:0',
    ownerFingerprint: 'property:entry/property:updatedTimestamp/call:.toISOString:0',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:runtimeEntry\u0000raw-literal:193:33:property:entry/property:updatedTimestamp/call:.toISOString:0',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
