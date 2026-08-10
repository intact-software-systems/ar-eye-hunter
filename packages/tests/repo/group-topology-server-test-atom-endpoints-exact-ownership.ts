import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

const declarationReason =
  'The pinned endpoint retains the same exact forbidden-import literal in its mapped handler dependency assertion; declaration disambiguates the two equal checks.';

export const declaredTopologyExactOwnershipAtomEndpoints = [
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
    sourceCaseId:
      'keeps handler imports directed toward contracts, authority, and retained services',
    sourceAtomId: 'raw-literal:57:42:call:expect().not.toContain:"AppGroupInboxService"',
    sourceFingerprint: 'call:expect().not.toContain:"AppGroupInboxService"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
    ownerCaseId:
      'keeps handler imports directed toward contracts, authority, and retained services',
    ownerAtomId: 'raw-literal:63:42:call:expect().not.toContain:"AppGroupInboxService"',
    ownerFingerprint: 'call:expect().not.toContain:"AppGroupInboxService"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
  {
    sourcePath: 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
    sourceCaseId:
      'keeps handler imports directed toward contracts, authority, and retained services',
    sourceAtomId: 'raw-literal:58:37:call:expect().not.toContain:"AppGroupInboxService"',
    sourceFingerprint: 'call:expect().not.toContain:"AppGroupInboxService"',
    ownerPath: 'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
    ownerCaseId:
      'keeps handler imports directed toward contracts, authority, and retained services',
    ownerAtomId: 'raw-literal:64:37:call:expect().not.toContain:"AppGroupInboxService"',
    ownerFingerprint: 'call:expect().not.toContain:"AppGroupInboxService"',
    disposition: 'declared-exact',
    declarationReason,
    consolidationId: null,
    consolidationReason: null,
  },
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];
