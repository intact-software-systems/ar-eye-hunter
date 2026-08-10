import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same deterministic compute input, pure phase, or orchestration-barrier responsibility.';

export const declaredTopologyComputeCaseAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'fixture:37:18:variable:input:deepFreeze:e00b60326b1ced80',
    sourceFingerprint: 'variable:input:deepFreeze:e00b60326b1ced80',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'computes and validates the same immutable config mutation twice',
    ownerAtomId:
      'fixture:21:29:variable:laterPolicyInput:deepFreezeTopologyTestValue:9750fca5c24db932',
    ownerFingerprint: 'variable:laterPolicyInput:deepFreezeTopologyTestValue:9750fca5c24db932',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:77:49:call:deepFreeze/property:facts/property:policyNowEpochMs:2000',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:policyNowEpochMs:2000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'computes and validates the same immutable config mutation twice',
    ownerAtomId:
      'raw-literal:23:49:call:deepFreezeTopologyTestValue/property:facts/property:policyNowEpochMs:2000',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:facts/property:policyNowEpochMs:2000',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:104:22:call:validateGroupTopologyConfigMutationRecord/property:receipt/property:outboxId:"state-mutation-attacker-selected"',
    sourceFingerprint:
      'call:validateGroupTopologyConfigMutationRecord/property:receipt/property:outboxId:"state-mutation-attacker-selected"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'computes and validates the same immutable config mutation twice',
    ownerAtomId:
      'raw-literal:45:18:call:expect/call:validateMutationRecord/property:outboxId:"state-mutation-attacker-selected"',
    ownerFingerprint:
      'call:expect/call:validateMutationRecord/property:outboxId:"state-mutation-attacker-selected"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:119:55:call:validateGroupTopologyConfigMutationRecord/property:receipt/property:acceptedConfig:null',
    sourceFingerprint:
      'call:validateGroupTopologyConfigMutationRecord/property:receipt/property:acceptedConfig:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'computes and validates the same immutable config mutation twice',
    ownerAtomId:
      'raw-literal:48:83:call:expect/call:validateMutationRecord/property:acceptedConfig:null',
    ownerFingerprint: 'call:expect/call:validateMutationRecord/property:acceptedConfig:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:135:44:property:receipt/property:acceptedConfig/property:topologyKind:"tree"',
    sourceFingerprint: 'property:receipt/property:acceptedConfig/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'computes and validates the same immutable config mutation twice',
    ownerAtomId:
      'raw-literal:54:40:call:validateMutationRecord/property:acceptedConfig/property:topologyKind:"tree"',
    ownerFingerprint:
      'call:validateMutationRecord/property:acceptedConfig/property:topologyKind:"tree"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
