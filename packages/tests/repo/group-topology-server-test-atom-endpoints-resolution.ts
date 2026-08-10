import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The source and target retain the same config precedence, default, patch, effective-value, or expiry-resolution responsibility.';

export const declaredTopologyResolutionAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId:
      'raw-literal:435:22:variable:durable/property:config/property:topologyKind:"tree"',
    sourceFingerprint: 'variable:durable/property:config/property:topologyKind:"tree"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:31:33:variable:durable/call:storedConfig:"tree"',
    ownerFingerprint: 'variable:durable/call:storedConfig:"tree"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:436:21:variable:durable/property:config/property:degreeLimit:4',
    sourceFingerprint: 'variable:durable/property:config/property:degreeLimit:4',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:31:41:variable:durable/call:storedConfig:4',
    ownerFingerprint: 'variable:durable/call:storedConfig:4',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:437:21:variable:durable/property:config/property:treeMinSize:6',
    sourceFingerprint: 'variable:durable/property:config/property:treeMinSize:6',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:119:54:function:storedConfig/property:config/property:treeMinSize:6',
    ownerFingerprint: 'function:storedConfig/property:config/property:treeMinSize:6',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts\u0000support:storedConfig\u0000raw-literal:119:54:function:storedConfig/property:config/property:treeMinSize:6',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:438:21:variable:durable/property:config/property:meshMinSize:16',
    sourceFingerprint: 'variable:durable/property:config/property:meshMinSize:16',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:31:44:variable:durable/call:storedConfig:16',
    ownerFingerprint: 'variable:durable/call:storedConfig:16',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:439:20:variable:durable/property:config/property:meshParamK:2',
    sourceFingerprint: 'variable:durable/property:config/property:meshParamK:2',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:119:82:function:storedConfig/property:config/property:meshParamK:2',
    ownerFingerprint: 'function:storedConfig/property:config/property:meshParamK:2',
    disposition: 'semantic',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts\u0000support:storedConfig\u0000raw-literal:119:82:function:storedConfig/property:config/property:meshParamK:2',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:441:15:variable:durable/property:version:1',
    sourceFingerprint: 'variable:durable/property:version:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:120:13:function:storedConfig/property:version:1',
    ownerFingerprint: 'function:storedConfig/property:version:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:442:24:variable:durable/property:createdAtEpochMs:1',
    sourceFingerprint: 'variable:durable/property:createdAtEpochMs:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:121:22:function:storedConfig/property:createdAtEpochMs:1',
    ownerFingerprint: 'function:storedConfig/property:createdAtEpochMs:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:443:24:variable:durable/property:updatedAtEpochMs:1',
    sourceFingerprint: 'variable:durable/property:updatedAtEpochMs:1',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:122:22:function:storedConfig/property:updatedAtEpochMs:1',
    ownerFingerprint: 'function:storedConfig/property:updatedAtEpochMs:1',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:444:28:variable:durable/property:updatedByPrincipalId:"owner"',
    sourceFingerprint: 'variable:durable/property:updatedByPrincipalId:"owner"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:123:26:function:storedConfig/property:updatedByPrincipalId:"owner"',
    ownerFingerprint: 'function:storedConfig/property:updatedByPrincipalId:"owner"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:445:17:variable:durable/property:requestId:"durable-config"',
    sourceFingerprint: 'variable:durable/property:requestId:"durable-config"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:124:15:function:storedConfig/property:requestId:"durable-config"',
    ownerFingerprint: 'function:storedConfig/property:requestId:"durable-config"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId:
      'raw-literal:450:22:variable:temporary/property:config/property:topologyKind:"mesh"',
    sourceFingerprint: 'variable:temporary/property:config/property:topologyKind:"mesh"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:32:40:variable:temporary/call:storedConfig:"mesh"',
    ownerFingerprint: 'variable:temporary/call:storedConfig:"mesh"',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:451:21:variable:temporary/property:config/property:degreeLimit:4',
    sourceFingerprint: 'variable:temporary/property:config/property:degreeLimit:4',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:32:48:variable:temporary/call:storedConfig:4',
    ownerFingerprint: 'variable:temporary/call:storedConfig:4',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:452:21:variable:temporary/property:config/property:treeMinSize:6',
    sourceFingerprint: 'variable:temporary/property:config/property:treeMinSize:6',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:119:54:function:storedConfig/property:config/property:treeMinSize:6',
    ownerFingerprint: 'function:storedConfig/property:config/property:treeMinSize:6',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts\u0000support:storedConfig\u0000raw-literal:119:54:function:storedConfig/property:config/property:treeMinSize:6',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:453:21:variable:temporary/property:config/property:meshMinSize:20',
    sourceFingerprint: 'variable:temporary/property:config/property:meshMinSize:20',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:32:51:variable:temporary/call:storedConfig:20',
    ownerFingerprint: 'variable:temporary/call:storedConfig:20',
    disposition: 'semantic',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:454:20:variable:temporary/property:config/property:meshParamK:2',
    sourceFingerprint: 'variable:temporary/property:config/property:meshParamK:2',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'support:storedConfig',
    ownerAtomId: 'raw-literal:119:82:function:storedConfig/property:config/property:meshParamK:2',
    ownerFingerprint: 'function:storedConfig/property:config/property:meshParamK:2',
    disposition: 'shared-fixture',
    declarationReason,
    consolidationId:
      'support:packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts\u0000support:storedConfig\u0000raw-literal:119:82:function:storedConfig/property:config/property:meshParamK:2',
    consolidationReason:
      'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.',
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
