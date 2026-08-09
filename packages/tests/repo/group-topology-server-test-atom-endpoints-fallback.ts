import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same durable/override clear action and immediate fallback responsibility.';

export const declaredTopologyFallbackAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId: 'fixture:147:25:variable:durableInput:createConfigMutationInput:3c18396db9312a5c',
    sourceFingerprint: 'variable:durableInput:createConfigMutationInput:3c18396db9312a5c',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'fixture:60:25:variable:durableInput:createTopologyConfigMutationTestInput:f575fe0cd48a6454',
    ownerFingerprint:
      'variable:durableInput:createTopologyConfigMutationTestInput:f575fe0cd48a6454',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:148:17:variable:durableInput/call:createConfigMutationInput/property:operation:"putConfig"',
    sourceFingerprint:
      'variable:durableInput/call:createConfigMutationInput/property:operation:"putConfig"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:61:17:variable:durableInput/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    ownerFingerprint:
      'variable:durableInput/call:createTopologyConfigMutationTestInput/property:operation:"putConfig"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:149:29:call:createConfigMutationInput/property:config/property:degreeLimit:null',
    sourceFingerprint: 'call:createConfigMutationInput/property:config/property:degreeLimit:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:62:29:call:createTopologyConfigMutationTestInput/property:config/property:degreeLimit:null',
    ownerFingerprint:
      'call:createTopologyConfigMutationTestInput/property:config/property:degreeLimit:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:150:26:variable:durableInput/call:createConfigMutationInput/property:durableDegreeLimit:9',
    sourceFingerprint:
      'variable:durableInput/call:createConfigMutationInput/property:durableDegreeLimit:9',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:63:26:variable:durableInput/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:9',
    ownerFingerprint:
      'variable:durableInput/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:9',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:151:27:variable:durableInput/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    sourceFingerprint:
      'variable:durableInput/call:createConfigMutationInput/property:overrideDegreeLimit:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:64:27:variable:durableInput/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    ownerFingerprint:
      'variable:durableInput/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'fixture:159:26:variable:overrideInput:createConfigMutationInput:a51391de3b2b4e28',
    sourceFingerprint: 'variable:overrideInput:createConfigMutationInput:a51391de3b2b4e28',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'fixture:72:26:variable:overrideInput:createTopologyConfigMutationTestInput:bc24252d1b4ca333',
    ownerFingerprint:
      'variable:overrideInput:createTopologyConfigMutationTestInput:bc24252d1b4ca333',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:160:17:variable:overrideInput/call:createConfigMutationInput/property:operation:"putOverride"',
    sourceFingerprint:
      'variable:overrideInput/call:createConfigMutationInput/property:operation:"putOverride"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:73:17:variable:overrideInput/call:createTopologyConfigMutationTestInput/property:operation:"putOverride"',
    ownerFingerprint:
      'variable:overrideInput/call:createTopologyConfigMutationTestInput/property:operation:"putOverride"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:161:29:call:createConfigMutationInput/property:config/property:degreeLimit:null',
    sourceFingerprint: 'call:createConfigMutationInput/property:config/property:degreeLimit:null',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:74:29:call:createTopologyConfigMutationTestInput/property:config/property:degreeLimit:null',
    ownerFingerprint:
      'call:createTopologyConfigMutationTestInput/property:config/property:degreeLimit:null',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:162:26:variable:overrideInput/call:createConfigMutationInput/property:durableDegreeLimit:4',
    sourceFingerprint:
      'variable:overrideInput/call:createConfigMutationInput/property:durableDegreeLimit:4',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:75:26:variable:overrideInput/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:4',
    ownerFingerprint:
      'variable:overrideInput/call:createTopologyConfigMutationTestInput/property:durableDegreeLimit:4',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'clears durable and override fields back to their immediate fallback',
    sourceAtomId:
      'raw-literal:163:27:variable:overrideInput/call:createConfigMutationInput/property:overrideDegreeLimit:9',
    sourceFingerprint:
      'variable:overrideInput/call:createConfigMutationInput/property:overrideDegreeLimit:9',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'clears durable and override fields back to their immediate fallback',
    ownerAtomId:
      'raw-literal:76:27:variable:overrideInput/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:9',
    ownerFingerprint:
      'variable:overrideInput/call:createTopologyConfigMutationTestInput/property:overrideDegreeLimit:9',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:388:6:variable:managementSource/call:readFileSync:"utf8"',
    sourceFingerprint: 'variable:managementSource/call:readFileSync:"utf8"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:readProductionSource',
    ownerAtomId: 'raw-literal:201:4:function:readProductionSource/call:readFileSync:"utf8"',
    ownerFingerprint: 'function:readProductionSource/call:readFileSync:"utf8"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts\u0000support:readProductionSource\u0000raw-literal:201:4:function:readProductionSource/call:readFileSync:"utf8"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'keeps pure topology config phases ambient-free and orchestration visible',
    sourceAtomId: 'raw-literal:395:6:variable:appInboxSource/call:readFileSync:"utf8"',
    sourceFingerprint: 'variable:appInboxSource/call:readFileSync:"utf8"',
    ownerPath:
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
    ownerCaseId: 'support:readProductionSource',
    ownerAtomId: 'raw-literal:201:4:function:readProductionSource/call:readFileSync:"utf8"',
    ownerFingerprint: 'function:readProductionSource/call:readFileSync:"utf8"',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts\u0000support:readProductionSource\u0000raw-literal:201:4:function:readProductionSource/call:readFileSync:"utf8"',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
