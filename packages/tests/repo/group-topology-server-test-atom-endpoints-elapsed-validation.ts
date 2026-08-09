import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same elapsed stable-expiry command, read, fact, or validation responsibility.';
const elapsedDeleteTargetReason =
  'The elapsed-expiry source deleteTarget null is pinned to deleteTarget null in the validation facts, never to resolved expiry null.';

export const declaredTopologyElapsedValidationAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:326:19:call:deepFreeze/property:command/property:operation:"putOverride"',
    sourceFingerprint: 'call:deepFreeze/property:command/property:operation:"putOverride"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'rejects an elapsed stable override expiry from pure facts',
    ownerAtomId:
      'raw-literal:93:17:variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putOverride"',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:operation:"putOverride"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:328:19:call:deepFreeze/property:command/property:commandId:"elapsed-stable-expiry"',
    sourceFingerprint:
      'call:deepFreeze/property:command/property:commandId:"elapsed-stable-expiry"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'rejects an elapsed stable override expiry from pure facts',
    ownerAtomId:
      'raw-literal:94:17:variable:mutation/call:createTopologyConfigMutationTestInput/property:commandId:"elapsed-stable-expiry"',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:commandId:"elapsed-stable-expiry"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:329:19:call:deepFreeze/property:command/property:requestId:"elapsed-stable-expiry"',
    sourceFingerprint:
      'call:deepFreeze/property:command/property:requestId:"elapsed-stable-expiry"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'rejects an elapsed stable override expiry from pure facts',
    ownerAtomId:
      'raw-literal:95:17:variable:mutation/call:createTopologyConfigMutationTestInput/property:requestId:"elapsed-stable-expiry"',
    ownerFingerprint:
      'variable:mutation/call:createTopologyConfigMutationTestInput/property:requestId:"elapsed-stable-expiry"',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId:
      'raw-literal:349:26:call:deepFreeze/property:facts/property:policyNowEpochMs:7000',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:policyNowEpochMs:7000',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'rejects an elapsed stable override expiry from pure facts',
    ownerAtomId:
      'raw-literal:100:54:call:computeTopologyConfigMutation/property:facts/property:policyNowEpochMs:7000',
    ownerFingerprint:
      'call:computeTopologyConfigMutation/property:facts/property:policyNowEpochMs:7000',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects an elapsed stable override expiry with explicit pure facts',
    sourceAtomId: 'raw-literal:354:22:call:deepFreeze/property:facts/property:deleteTarget:null',
    sourceFingerprint: 'call:deepFreeze/property:facts/property:deleteTarget:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
    ownerCaseId: 'rejects an elapsed stable override expiry from pure facts',
    ownerAtomId:
      'raw-literal:100:75:call:computeTopologyConfigMutation/property:facts/property:deleteTarget:null',
    ownerFingerprint:
      'call:computeTopologyConfigMutation/property:facts/property:deleteTarget:null',
    disposition: 'semantic',
    declarationReason: elapsedDeleteTargetReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
