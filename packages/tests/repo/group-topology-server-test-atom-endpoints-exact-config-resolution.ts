import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The pinned endpoint retains the same exact config-mutation literal in its mapped compute, validation, idempotency, or resolution responsibility; declaration disambiguates repeated values.';

export const declaredTopologyExactConfigResolutionAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:477:19:call:expect().toEqual/property:treeMinSize:6',
    sourceFingerprint: 'call:expect().toEqual/property:treeMinSize:6',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:43:19:call:expect().toEqual/property:treeMinSize:6',
    ownerFingerprint: 'call:expect().toEqual/property:treeMinSize:6',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:479:18:call:expect().toEqual/property:meshParamK:2',
    sourceFingerprint: 'call:expect().toEqual/property:meshParamK:2',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:45:18:call:expect().toEqual/property:meshParamK:2',
    ownerFingerprint: 'call:expect().toEqual/property:meshParamK:2',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:483:19:call:expect().toEqual/property:degreeLimit:8',
    sourceFingerprint: 'call:expect().toEqual/property:degreeLimit:8',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:49:19:call:expect().toEqual/property:degreeLimit:8',
    ownerFingerprint: 'call:expect().toEqual/property:degreeLimit:8',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:484:19:call:expect().toEqual/property:treeMinSize:6',
    sourceFingerprint: 'call:expect().toEqual/property:treeMinSize:6',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:50:19:call:expect().toEqual/property:treeMinSize:6',
    ownerFingerprint: 'call:expect().toEqual/property:treeMinSize:6',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:486:18:call:expect().toEqual/property:meshParamK:2',
    sourceFingerprint: 'call:expect().toEqual/property:meshParamK:2',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:52:18:call:expect().toEqual/property:meshParamK:2',
    ownerFingerprint: 'call:expect().toEqual/property:meshParamK:2',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId:
      'resolves server defaults, durable config, temporary override, and request options',
    sourceAtomId: 'raw-literal:490:55:call:expect().toEqual/property:degreeLimit:8',
    sourceFingerprint: 'call:expect().toEqual/property:degreeLimit:8',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'resolves defaults, durable config, temporary override, and request options in order',
    ownerAtomId: 'raw-literal:56:55:call:expect().toEqual/property:degreeLimit:8',
    ownerFingerprint: 'call:expect().toEqual/property:degreeLimit:8',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects invalid topology config patches and effective config combinations',
    sourceAtomId:
      'raw-literal:516:22:call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    sourceFingerprint:
      'call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'preserves default values and rejects invalid patches and effective combinations',
    ownerAtomId:
      'raw-literal:78:22:call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    ownerFingerprint:
      'call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects invalid topology config patches and effective config combinations',
    sourceAtomId:
      'raw-literal:525:22:call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    sourceFingerprint:
      'call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId: 'preserves default values and rejects invalid patches and effective combinations',
    ownerAtomId:
      'raw-literal:87:22:call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    ownerFingerprint:
      'call:expect/call:validateEffectiveGroupTopologyConfig/property:topologyKind:"auto"',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    sourceAtomId:
      'raw-literal:535:57:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    sourceFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId:
      'raw-literal:97:57:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    sourceAtomId: 'raw-literal:536:6:call:expect().toBe:1000',
    sourceFingerprint: 'call:expect().toBe:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId: 'raw-literal:98:6:call:expect().toBe:1000',
    ownerFingerprint: 'call:expect().toBe:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    sourceAtomId:
      'raw-literal:540:20:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    sourceFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId:
      'raw-literal:100:57:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    sourceAtomId:
      'raw-literal:546:20:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    sourceFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId:
      'raw-literal:103:20:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    sourceAtomId: 'raw-literal:549:11:call:expect().toBe:1000',
    sourceFingerprint: 'call:expect().toBe:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId: 'raw-literal:106:11:call:expect().toBe:1000',
    ownerFingerprint: 'call:expect().toBe:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects temporary override expiries that are not in the future',
    sourceAtomId:
      'raw-literal:555:20:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    sourceFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId:
      'raw-literal:107:63:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/group-topology-config-service.test.ts',
    sourceCaseId: 'rejects temporary override expiries that are not in the future',
    sourceAtomId:
      'raw-literal:561:20:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    sourceFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerPath:
      'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
    ownerCaseId:
      'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
    ownerAtomId:
      'raw-literal:111:52:call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    ownerFingerprint: 'call:expect/call:resolveOverrideExpiresAtEpochMs/property:nowEpochMs:1000',
    disposition: 'declared-exact',
    declarationReason: declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
