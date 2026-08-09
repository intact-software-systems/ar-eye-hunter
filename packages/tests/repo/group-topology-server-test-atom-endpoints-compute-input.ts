import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same deterministic compute input, pure phase, or orchestration-barrier responsibility.';

export const declaredTopologyComputeInputAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:39:19:call:deepFreeze/property:command/property:operation:"putConfig"',
    sourceFingerprint: 'call:deepFreeze/property:command/property:operation:"putConfig"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:149:17:call:deepFreezeTopologyTestValue/property:command/property:operation:"putConfig"',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:command/property:operation:"putConfig"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:41:19:call:deepFreeze/property:command/property:commandId:"config-command-1"',
    sourceFingerprint: 'call:deepFreeze/property:command/property:commandId:"config-command-1"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:151:17:call:deepFreezeTopologyTestValue/property:command/property:commandId:"config-command-1"',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:command/property:commandId:"config-command-1"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:42:19:call:deepFreeze/property:command/property:requestId:"config-command-1"',
    sourceFingerprint: 'call:deepFreeze/property:command/property:requestId:"config-command-1"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:152:17:call:deepFreezeTopologyTestValue/property:command/property:requestId:"config-command-1"',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:command/property:requestId:"config-command-1"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:51:16:call:deepFreeze/property:read/property:config:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:config:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:161:14:call:deepFreezeTopologyTestValue/property:read/property:config:null',
    ownerFingerprint: 'call:deepFreezeTopologyTestValue/property:read/property:config:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:52:18:call:deepFreeze/property:read/property:override:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:override:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:162:16:call:deepFreezeTopologyTestValue/property:read/property:override:null',
    ownerFingerprint: 'call:deepFreezeTopologyTestValue/property:read/property:override:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:53:26:call:deepFreeze/property:read/property:configGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:configGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:163:24:call:deepFreezeTopologyTestValue/property:read/property:configGeneration:null',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:read/property:configGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:54:28:call:deepFreeze/property:read/property:overrideGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:overrideGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:164:26:call:deepFreezeTopologyTestValue/property:read/property:overrideGeneration:null',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:read/property:overrideGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:55:29:call:deepFreeze/property:read/property:invariantGeneration:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:invariantGeneration:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:165:27:call:deepFreezeTopologyTestValue/property:read/property:invariantGeneration:null',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:read/property:invariantGeneration:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:56:21:call:deepFreeze/property:read/property:idempotency:null',
    sourceFingerprint: 'call:deepFreeze/property:read/property:idempotency:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:166:19:call:deepFreezeTopologyTestValue/property:read/property:idempotency:null',
    ownerFingerprint: 'call:deepFreezeTopologyTestValue/property:read/property:idempotency:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:58:55:property:read/property:groupAuthorityGuard/call:createGroupAuthorityGuard:40',
    sourceFingerprint:
      'property:read/property:groupAuthorityGuard/call:createGroupAuthorityGuard:40',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:168:60:property:read/property:groupAuthorityGuard/call:createTopologyTestAuthorityGuard:40',
    ownerFingerprint:
      'property:read/property:groupAuthorityGuard/call:createTopologyTestAuthorityGuard:40',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:61:28:call:deepFreeze/property:facts/property:requestedAtEpochMs:1000',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:requestedAtEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:171:26:call:deepFreezeTopologyTestValue/property:facts/property:requestedAtEpochMs:1000',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:facts/property:requestedAtEpochMs:1000',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:62:26:call:deepFreeze/property:facts/property:policyNowEpochMs:1000',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:policyNowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:172:24:call:deepFreezeTopologyTestValue/property:facts/property:policyNowEpochMs:1000',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:facts/property:policyNowEpochMs:1000',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:64:22:call:deepFreeze/property:facts/property:attemptCount:1',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:attemptCount:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:174:20:call:deepFreezeTopologyTestValue/property:facts/property:attemptCount:1',
    ownerFingerprint: 'call:deepFreezeTopologyTestValue/property:facts/property:attemptCount:1',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:65:25:call:deepFreeze/property:facts/property:isPlatformAdmin:false',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:isPlatformAdmin:false',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:175:23:call:deepFreezeTopologyTestValue/property:facts/property:isPlatformAdmin:false',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:facts/property:isPlatformAdmin:false',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'raw-literal:66:42:call:deepFreeze/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    sourceFingerprint:
      'call:deepFreeze/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:176:40:call:deepFreezeTopologyTestValue/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    ownerFingerprint:
      'call:deepFreezeTopologyTestValue/property:facts/property:resolvedOverrideExpiresAtEpochMs:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'raw-literal:67:22:call:deepFreeze/property:facts/property:deleteTarget:null',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:deleteTarget:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:deterministicMutationInput',
    ownerAtomId:
      'raw-literal:177:20:call:deepFreezeTopologyTestValue/property:facts/property:deleteTarget:null',
    ownerFingerprint: 'call:deepFreezeTopologyTestValue/property:facts/property:deleteTarget:null',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
