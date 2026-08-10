import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same deterministic compute input, pure phase, or orchestration-barrier responsibility.';

export const declaredTopologyComputeSupportAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'fixture:40:22:call:deepFreeze/property:command/property:aggregateRef:createGroupRef:c95f65de29bc1345',
    sourceFingerprint:
      'call:deepFreeze/property:command/property:aggregateRef:createGroupRef:c95f65de29bc1345',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupRef',
    ownerAtomId: 'fixture:53:7:declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    ownerFingerprint: 'declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupRef\u0000fixture:53:7:declaration:createTopologyTestGroupRef:e2abad2fbeb83156',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'fixture:57:23:call:deepFreeze/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
    sourceFingerprint:
      'call:deepFreeze/property:read/property:groupSnapshot:createGroupSnapshot:64a9d31219f23fd8',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestGroupSnapshot',
    ownerAtomId: 'fixture:61:7:declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    ownerFingerprint: 'declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestGroupSnapshot\u0000fixture:61:7:declaration:createTopologyTestGroupSnapshot:a69188725998a224',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId:
      'fixture:58:29:call:deepFreeze/property:read/property:groupAuthorityGuard:createGroupAuthorityGuard:683c2337dd5ee8e3',
    sourceFingerprint:
      'call:deepFreeze/property:read/property:groupAuthorityGuard:createGroupAuthorityGuard:683c2337dd5ee8e3',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:createTopologyTestAuthorityGuard',
    ownerAtomId: 'fixture:112:7:declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    ownerFingerprint: 'declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:createTopologyTestAuthorityGuard\u0000fixture:112:7:declaration:createTopologyTestAuthorityGuard:62ec20c270cd222f',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'computes and validates the same immutable config mutation twice',
    sourceAtomId: 'fixture:75:29:variable:laterPolicyInput:deepFreeze:9e11599f9db9b7f3',
    sourceFingerprint: 'variable:laterPolicyInput:deepFreeze:9e11599f9db9b7f3',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ownerCaseId: 'support:deepFreezeTopologyTestValue',
    ownerAtomId: 'fixture:127:7:declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    ownerFingerprint: 'declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    disposition: 'semantic',
    declarationReason: declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts\u0000support:deepFreezeTopologyTestValue\u0000fixture:127:7:declaration:deepFreezeTopologyTestValue:37e96dd50e7171fb',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
