import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same hidden-invalid, lifecycle-denial, or replay-corruption validation responsibility.';
const replayDegreeLimitReason =
  'The replay-corruption source degreeLimit 5 is pinned to durableDegreeLimit 5 in the idempotency case, never to an unrelated treeMinSize 5.';
const replayOverrideReason =
  'The replay-corruption source override null is pinned to overrideDegreeLimit null in the idempotency case, never to an unrelated ttlMs null.';

export const declaredTopologyValidationAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    sourceAtomId: 'fixture:173:18:variable:input:createConfigMutationInput:de4574ec9b785952',
    sourceFingerprint: 'variable:input:createConfigMutationInput:de4574ec9b785952',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    ownerAtomId:
      'fixture:25:21:variable:mutation:createTopologyConfigMutationTestInput:4fc8713c0f8ad324',
    ownerFingerprint: 'variable:mutation:createTopologyConfigMutationTestInput:4fc8713c0f8ad324',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    sourceAtomId:
      'raw-literal:174:17:variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    ownerAtomId:
      'raw-literal:26:17:variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    sourceAtomId:
      'raw-literal:175:28:call:createConfigMutationInput/property:config/property:meshParamK:4',
    sourceFingerprint: 'call:createConfigMutationInput/property:config/property:meshParamK:4',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    ownerAtomId:
      'raw-literal:27:28:call:createTopologyConfigMutationTestInput/property:config/property:meshParamK:4',
    ownerFingerprint:
      'call:createTopologyConfigMutationTestInput/property:config/property:meshParamK:4',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    sourceAtomId:
      'raw-literal:176:26:variable:input/call:createConfigMutationInput/property:durableDegreeLimit:3',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:durableDegreeLimit:3',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    ownerAtomId:
      'raw-literal:28:26:variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:3',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:3',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    sourceAtomId:
      'raw-literal:177:27:variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:5',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:5',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId:
      'rejects an invalid durable config even when a temporary override hides it until expiry',
    ownerAtomId:
      'raw-literal:29:27:variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:5',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:5',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    sourceAtomId: 'fixture:189:18:variable:input:createConfigMutationInput:4d9145a7d9b699cb',
    sourceFingerprint: 'variable:input:createConfigMutationInput:4d9145a7d9b699cb',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    ownerAtomId:
      'fixture:57:21:variable:mutation:createTopologyConfigMutationTestInput:b88c858446a5d175',
    ownerFingerprint: 'variable:mutation:createTopologyConfigMutationTestInput:b88c858446a5d175',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    sourceAtomId:
      'raw-literal:190:17:variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    ownerAtomId:
      'raw-literal:58:17:variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    sourceAtomId:
      'raw-literal:191:30:call:createConfigMutationInput/property:config/property:topologyKind:"tree"',
    sourceFingerprint:
      'call:createConfigMutationInput/property:config/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    ownerAtomId:
      'raw-literal:59:30:call:createTopologyConfigMutationTestInput/property:config/property:topologyKind:"tree"',
    ownerFingerprint:
      'call:createTopologyConfigMutationTestInput/property:config/property:topologyKind:"tree"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    sourceAtomId:
      'raw-literal:192:26:variable:input/call:createConfigMutationInput/property:durableDegreeLimit:5',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:durableDegreeLimit:5',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    ownerAtomId:
      'raw-literal:60:26:variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:5',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:5',
    disposition: 'semantic',
    declarationReason: replayDegreeLimitReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    sourceAtomId:
      'raw-literal:193:27:variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'denies expired and terminal lifecycle mutations to platform admins',
    ownerAtomId:
      'raw-literal:61:27:variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    disposition: 'semantic',
    declarationReason: replayOverrideReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId: 'fixture:234:18:variable:input:createConfigMutationInput:4d9145a7d9b699cb',
    sourceFingerprint: 'variable:input:createConfigMutationInput:4d9145a7d9b699cb',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
    ownerCaseId: 'rejects compact replay receipt operation corruption against the verified command',
    ownerAtomId:
      'fixture:59:21:variable:mutation:createTopologyConfigMutationTestInput:e6a95ca02f543d50',
    ownerFingerprint: 'variable:mutation:createTopologyConfigMutationTestInput:e6a95ca02f543d50',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId:
      'raw-literal:235:17:variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:operation:"putConfig"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId:
      'raw-literal:21:42:function:createTopologyConfigMutationTestInput/variable:operation:"putConfig"',
    ownerFingerprint:
      'function:createTopologyConfigMutationTestInput/variable:operation:"putConfig"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId:
      'raw-literal:236:30:call:createConfigMutationInput/property:config/property:topologyKind:"tree"',
    sourceFingerprint:
      'call:createConfigMutationInput/property:config/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyConfigMutationTestInput',
    ownerAtomId: 'raw-literal:36:49:property:input/property:config/property:topologyKind:"tree"',
    ownerFingerprint: 'property:input/property:config/property:topologyKind:"tree"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyConfigMutationTestInput\u0000raw-literal:36:49:property:input/property:config/property:topologyKind:"tree"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId:
      'raw-literal:237:26:variable:input/call:createConfigMutationInput/property:durableDegreeLimit:5',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:durableDegreeLimit:5',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
    ownerCaseId: 'rejects compact replay receipt operation corruption against the verified command',
    ownerAtomId:
      'raw-literal:60:26:variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:5',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:5',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId:
      'raw-literal:238:27:variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    sourceFingerprint:
      'variable:input/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
    ownerCaseId: 'rejects compact replay receipt operation corruption against the verified command',
    ownerAtomId:
      'raw-literal:61:27:variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'rejects compact replay receipt operation corruption against the verified command',
    sourceAtomId: 'raw-literal:267:22:property:idempotency/property:entry/property:revision:0',
    sourceFingerprint: 'property:idempotency/property:entry/property:revision:0',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
    ownerCaseId: 'support:runtimeEntry',
    ownerAtomId: 'raw-literal:95:16:function:runtimeEntry/property:entry/property:revision:0',
    ownerFingerprint: 'function:runtimeEntry/property:entry/property:revision:0',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an impossible %s no-op receipt at the pure validator boundary',
    sourceAtomId: 'fixture:281:23:variable:groupRef:createGroupRef:c95f65de29bc1345',
    sourceFingerprint: 'variable:groupRef:createGroupRef:c95f65de29bc1345',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts',
    ownerCaseId: 'rejects an impossible %s no-op receipt at the pure validator boundary',
    ownerAtomId: 'fixture:46:23:variable:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    ownerFingerprint: 'variable:groupRef:createTopologyTestGroupRef:ff3518357e416acc',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
